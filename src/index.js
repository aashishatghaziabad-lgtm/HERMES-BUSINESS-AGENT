export default {
  async fetch(request, env) {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    try {
      await env.DB.prepare(
        "ALTER TABLE tasks ADD COLUMN result TEXT"
      ).run();
    } catch (e) {
      // result column already exists
    }
    await env.DB.prepare(`
  CREATE TABLE IF NOT EXISTS task_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    step_number INTEGER NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )
`).run();
// Create a new task
if (
  request.method === "POST" &&
  new URL(request.url).pathname === "/task"
) {
  const data = await request.json();

  if (!data.task || typeof data.task !== "string") {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Task is required"
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" }
      }
    );
  }

  const result = await env.DB.prepare(
    "INSERT INTO tasks (task, status) VALUES (?, ?)"
  )
    .bind(data.task.trim(), "pending")
    .run();

  return new Response(
    JSON.stringify({
      success: true,
      task_id: result.meta.last_row_id,
      status: "pending",
      message: "Task added to Hermes 🧠"
    }),
    {
      headers: { "content-type": "application/json" }
    }
  );
}
    // Run one pending task
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/run"
    ) {
      const task = await env.DB.prepare(
        "SELECT * FROM tasks WHERE status = 'pending' ORDER BY id ASC LIMIT 1"
      ).first();

      if (!task) {
        return new Response(
          JSON.stringify({
            success: true,
            message: "No pending tasks 💤"
          }),
          { headers: { "content-type": "application/json" } }
        );
      }

      await env.DB.prepare(
        "UPDATE tasks SET status = 'running' WHERE id = ?"
      ).bind(task.id).run();

      try {
        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `You are Hermes, an autonomous digital business assistant.

Your job is to create a clear execution plan for the user's task.

Return ONLY valid JSON in this exact structure:

{
  "goal": "short description of the goal",
  "steps": [
    {
      "id": 1,
      "action": "what needs to be done",
      "status": "pending"
    }
  ]
}

Break the task into practical, executable steps.
Do not perform the task yet.
Do not include markdown or explanations outside the JSON.

User task:
${task.task}`                    }
                  ]
                }
              ]
            })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data?.error?.message || "Gemini API request failed"
          );
        }

        const result =
          data?.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("") || "Gemini returned no text.";
        const cleanResult = result
  .replace(/^```json\s*/i, "")
  .replace(/\s*```$/i, "")
  .trim();

const plan = JSON.parse(cleanResult);

for (const step of plan.steps) {
  await env.DB.prepare(`
    INSERT INTO task_steps
    (task_id, step_number, action, status)
    VALUES (?, ?, ?, ?)
  `)
    .bind(
      task.id,
      step.id,
      step.action,
      step.status || "pending"
    )
    .run();
}

        await env.DB.prepare(
          "UPDATE tasks SET status = 'completed', result = ? WHERE id = ?"
        ).bind(cleanResult, task.id).run();

        return new Response(
          JSON.stringify({
            success: true,
            task_id: task.id,
            status: "completed",
            result
          }),
          { headers: { "content-type": "application/json" } }
        );

      } catch (error) {
        await env.DB.prepare(
          "UPDATE tasks SET status = 'failed', result = ? WHERE id = ?"
        ).bind(error.message, task.id).run();

        return new Response(
          JSON.stringify({
            success: false,
            task_id: task.id,
            status: "failed",
            error: error.message
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }
    // Clear test tasks
if (
  request.method === "POST" &&
  new URL(request.url).pathname === "/cleanup"
) {
  await env.DB.prepare("DELETE FROM task_steps").run();
  await env.DB.prepare("DELETE FROM tasks").run();

  return new Response(
    JSON.stringify({
      success: true,
      message: "Test tasks cleared 🧹"
    }),
    {
      headers: {
        "content-type": "application/json"
      }
    }
  );
}
    // Execute one pending step
if (
  request.method === "POST" &&
  new URL(request.url).pathname === "/step"
) {
  const step = await env.DB.prepare(`
    SELECT * FROM task_steps
    WHERE status = 'pending'
    ORDER BY task_id ASC, step_number ASC
    LIMIT 1
  `).first();

  if (!step) {
    return new Response(
      JSON.stringify({
        success: true,
        message: "No pending steps 💤"
      }),
      {
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }

  // Mark step as running and record an attempt
  await env.DB.prepare(`
    UPDATE task_steps
    SET status = 'running',
        attempts = attempts + 1
    WHERE id = ?
  `)
    .bind(step.id)
    .run();

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `You are Hermes executing one step of a larger task.

Execute this step as helpfully as possible:

${step.action}

Return a concise result describing what you accomplished.
`
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.error?.message || "Gemini API request failed"
      );
    }

    const result =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") || "Gemini returned no text.";

    await env.DB.prepare(`
      UPDATE task_steps
      SET status = 'completed',
          result = ?
      WHERE id = ?
    `)
      .bind(result, step.id)
      .run();

    return new Response(
      JSON.stringify({
        success: true,
        step_id: step.id,
        task_id: step.task_id,
        status: "completed",
        result
      }),
      {
        headers: {
          "content-type": "application/json"
        }
      }
    );

  } catch (error) {
    await env.DB.prepare(`
      UPDATE task_steps
      SET status = 'failed',
          result = ?
      WHERE id = ?
    `)
      .bind(error.message, step.id)
      .run();

    return new Response(
      JSON.stringify({
        success: false,
        step_id: step.id,
        task_id: step.task_id,
        status: "failed",
        error: error.message
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }
}
    // Show task steps
if (
  request.method === "GET" &&
  new URL(request.url).pathname === "/steps"
) {
  const taskId = new URL(request.url).searchParams.get("task_id");

  const steps = await env.DB.prepare(
    "SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_number ASC"
  )
    .bind(taskId)
    .all();

  return new Response(
    JSON.stringify({
      task_id: taskId,
      steps: steps.results
    }),
    {
      headers: {
        "content-type": "application/json"
      }
    }
  );
}

    // Show Hermes memory
    const tasks = await env.DB.prepare(
      "SELECT * FROM tasks ORDER BY id DESC"
    ).all();

    return new Response(
      JSON.stringify({
        hermes: "alive 🚀",
        memory: "connected 🧠",
        tasks: tasks.results
      }),
      { headers: { "content-type": "application/json" } }
    );
  }
};
