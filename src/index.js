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
