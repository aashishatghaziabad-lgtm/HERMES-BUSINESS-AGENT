export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // DATABASE SETUP
    // =========================================================

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    try {
      await env.DB.prepare(
        "ALTER TABLE tasks ADD COLUMN result TEXT"
      ).run();
    } catch (e) {
      // Column already exists
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

    // =========================================================
    // CREATE TASK
    // POST /task
    // =========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/task"
    ) {
      let data;

      try {
        data = await request.json();
      } catch (error) {
        return json({
          success: false,
          error: "Invalid JSON body"
        }, 400);
      }

      if (
        !data.task ||
        typeof data.task !== "string" ||
        !data.task.trim()
      ) {
        return json({
          success: false,
          error: "Task is required"
        }, 400);
      }

      const result = await env.DB.prepare(
        "INSERT INTO tasks (task, status) VALUES (?, ?)"
      )
        .bind(data.task.trim(), "pending")
        .run();

      return json({
        success: true,
        task_id: result.meta.last_row_id,
        status: "pending",
        message: "Task added to Hermes 🧠"
      });
    }

    // =========================================================
    // PLAN TASK
    // POST /plan?task_id=18
    // =========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/plan"
    ) {
      const taskId = url.searchParams.get("task_id");

      if (!taskId) {
        return json({
          success: false,
          error: "task_id is required"
        }, 400);
      }

      const task = await env.DB.prepare(
        "SELECT * FROM tasks WHERE id = ?"
      )
        .bind(taskId)
        .first();

      if (!task) {
        return json({
          success: false,
          error: "Task not found"
        }, 404);
      }

      if (task.status !== "pending") {
        return json({
          success: false,
          error: `Task is already ${task.status}`
        }, 400);
      }

      await env.DB.prepare(
        "UPDATE tasks SET status = 'planning' WHERE id = ?"
      )
        .bind(task.id)
        .run();

      try {
        const response = await callAI(
          env,
          `
You are Hermes, an autonomous digital business assistant.

Create a practical execution plan for this task.

Return ONLY valid JSON in exactly this structure:

{
  "goal": "short description",
  "steps": [
    {
      "id": 1,
      "action": "specific executable action"
    }
  ]
}

Rules:
- Create practical steps.
- Do not perform the task yet.
- Each step must describe one clear action.
- Do not include markdown.
- Do not include explanations outside the JSON.

USER TASK:
${task.task}
          `,
          false
        );

        const cleanResult = cleanJson(response.text);
        const plan = JSON.parse(cleanResult);

        if (
          !plan.steps ||
          !Array.isArray(plan.steps) ||
          plan.steps.length === 0
        ) {
          throw new Error("AI returned an invalid plan");
        }

        for (const step of plan.steps) {
          await env.DB.prepare(`
            INSERT INTO task_steps
            (task_id, step_number, action, status)
            VALUES (?, ?, ?, 'pending')
          `)
            .bind(
              task.id,
              step.id,
              step.action
            )
            .run();
        }

        await env.DB.prepare(
          "UPDATE tasks SET status = 'planned', result = ? WHERE id = ?"
        )
          .bind(cleanResult, task.id)
          .run();

        return json({
          success: true,
          task_id: task.id,
          status: "planned",
          plan,
          provider: response.provider
        });

      } catch (error) {
        await env.DB.prepare(
          "UPDATE tasks SET status = 'failed', result = ? WHERE id = ?"
        )
          .bind(error.message, task.id)
          .run();

        return json({
          success: false,
          task_id: task.id,
          status: "failed",
          error: error.message
        }, 500);
      }
    }

    // =========================================================
    // EXECUTE ONE STEP
    // POST /step?task_id=18
    // =========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/step"
    ) {
      const taskId = url.searchParams.get("task_id");

      if (!taskId) {
        return json({
          success: false,
          error: "task_id is required"
        }, 400);
      }

      const task = await env.DB.prepare(
        "SELECT * FROM tasks WHERE id = ?"
      )
        .bind(taskId)
        .first();

      if (!task) {
        return json({
          success: false,
          error: "Task not found"
        }, 404);
      }

      const step = await env.DB.prepare(`
        SELECT *
        FROM task_steps
        WHERE task_id = ?
        AND status = 'pending'
        ORDER BY step_number ASC
        LIMIT 1
      `)
        .bind(task.id)
        .first();

      if (!step) {
        return json({
          success: true,
          message: "No pending steps for this task 💤"
        });
      }

      await env.DB.prepare(`
        UPDATE task_steps
        SET status = 'running',
            attempts = attempts + 1
        WHERE id = ?
      `)
        .bind(step.id)
        .run();

      await env.DB.prepare(
        "UPDATE tasks SET status = 'running' WHERE id = ?"
      )
        .bind(task.id)
        .run();

      try {
        const response = await callAI(
          env,
          `
You are Hermes executing one step of an autonomous task.

OVERALL TASK:
${task.task}

CURRENT STEP:
${step.action}

Execute the step as helpfully as possible.

If web research is useful, use available web/search tools.

Return a concise result containing:
1. What you found or accomplished.
2. Important evidence or facts.
3. Sources when web research was used.

Do not pretend that an action was performed if you only generated instructions.

Clearly distinguish:
- facts
- analysis
- things you could not verify
          `,
          true
        );

        await env.DB.prepare(`
          UPDATE task_steps
          SET status = 'completed',
              result = ?
          WHERE id = ?
        `)
          .bind(response.text, step.id)
          .run();

        return json({
          success: true,
          task_id: task.id,
          step_id: step.id,
          step_number: step.step_number,
          status: "completed",
          provider: response.provider,
          result: response.text
        });

      } catch (error) {
        const attempts = step.attempts + 1;
        const nextStatus =
          attempts < 3 ? "pending" : "failed";

        await env.DB.prepare(`
          UPDATE task_steps
          SET status = ?,
              result = ?
          WHERE id = ?
        `)
          .bind(
            nextStatus,
            error.message,
            step.id
          )
          .run();

        await env.DB.prepare(`
          UPDATE tasks
          SET status = ?
          WHERE id = ?
        `)
          .bind(
            nextStatus === "pending"
              ? "planned"
              : "failed",
            task.id
          )
          .run();

        return json({
          success: false,
          task_id: task.id,
          step_id: step.id,
          step_number: step.step_number,
          status:
            nextStatus === "pending"
              ? "retrying"
              : "failed",
          attempts,
          error: error.message
        }, 500);
      }
    }

    // =========================================================
    // RUN TASK
    // POST /run-task?task_id=18
    // =========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/run-task"
    ) {
      const taskId = url.searchParams.get("task_id");

      if (!taskId) {
        return json({
          success: false,
          error: "task_id is required"
        }, 400);
      }

      const task = await env.DB.prepare(
        "SELECT * FROM tasks WHERE id = ?"
      )
        .bind(taskId)
        .first();

      if (!task) {
        return json({
          success: false,
          error: "Task not found"
        }, 404);
      }

      const steps = await env.DB.prepare(`
        SELECT *
        FROM task_steps
        WHERE task_id = ?
        ORDER BY step_number ASC
      `)
        .bind(task.id)
        .all();

      if (steps.results.length === 0) {
        return json({
          success: false,
          error: "Task has no planned steps"
        }, 400);
      }

      const pendingSteps = steps.results.filter(
        step => step.status === "pending"
      );

      const failedSteps = steps.results.filter(
        step => step.status === "failed"
      );

      if (failedSteps.length > 0) {
        await env.DB.prepare(
          "UPDATE tasks SET status = 'failed' WHERE id = ?"
        )
          .bind(task.id)
          .run();

        return json({
          success: false,
          task_id: task.id,
          status: "failed",
          message: "Task contains failed steps"
        });
      }

      if (pendingSteps.length === 0) {
        await env.DB.prepare(
          "UPDATE tasks SET status = 'completed' WHERE id = ?"
        )
          .bind(task.id)
          .run();

        return json({
          success: true,
          task_id: task.id,
          status: "completed",
          message: "All steps already completed 🎉"
        });
      }

      const step = pendingSteps[0];

      const stepResponse = await executeStep(
        env,
        task,
        step
      );

      if (!stepResponse.success) {
        return json(stepResponse, 500);
      }

      const remaining = await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM task_steps
        WHERE task_id = ?
        AND status != 'completed'
      `)
        .bind(task.id)
        .first();

      if (Number(remaining.count) === 0) {
        await env.DB.prepare(
          "UPDATE tasks SET status = 'completed' WHERE id = ?"
        )
          .bind(task.id)
          .run();

        return json({
          success: true,
          task_id: task.id,
          status: "completed",
          message: "All task steps completed 🎉",
          last_step: stepResponse
        });
      }

      await env.DB.prepare(
        "UPDATE tasks SET status = 'planned' WHERE id = ?"
      )
        .bind(task.id)
        .run();

      return json({
        success: true,
        task_id: task.id,
        status: "planned",
        message: "Step completed. More steps remain.",
        completed_step: stepResponse,
        remaining_steps: Number(remaining.count)
      });
    }
    // =========================================================
// WEB SEARCH TOOL
// POST /search
// =========================================================

if (
  request.method === "POST" &&
  url.pathname === "/search"
) {
  let data;

  try {
    data = await request.json();
  } catch (error) {
    return json({
      success: false,
      error: "Invalid JSON body"
    }, 400);
  }

  if (
    !data.query ||
    typeof data.query !== "string" ||
    !data.query.trim()
  ) {
    return json({
      success: false,
      error: "Search query is required"
    }, 400);
  }

  try {
    const response = await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          api_key: env.TAVILY_API_KEY,
          query: data.query.trim(),
          search_depth: "basic",
          max_results: 5,
          include_answer: true
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result?.detail ||
        result?.error ||
        "Tavily search failed"
      );
    }

    return json({
      success: true,
      tool: "web_search",
      query: data.query.trim(),
      answer: result.answer || null,
      results: result.results || []
    });

  } catch (error) {
    return json({
      success: false,
      tool: "web_search",
      error: error.message
    }, 500);
  }
}

    // =========================================================
    // VIEW TASK STEPS
    // GET /steps?task_id=18
    // =========================================================

    if (
      request.method === "GET" &&
      url.pathname === "/steps"
    ) {
      const taskId = url.searchParams.get("task_id");

      if (!taskId) {
        return json({
          success: false,
          error: "task_id is required"
        }, 400);
      }

      const steps = await env.DB.prepare(`
        SELECT *
        FROM task_steps
        WHERE task_id = ?
        ORDER BY step_number ASC
      `)
        .bind(taskId)
        .all();

      return json({
        task_id: taskId,
        steps: steps.results
      });
    }

    // =========================================================
    // SAFE TEST CLEANUP
    // POST /cleanup?confirm=TEST_ONLY
    // =========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/cleanup"
    ) {
      const confirmation =
        url.searchParams.get("confirm");

      if (confirmation !== "TEST_ONLY") {
        return json({
          success: false,
          error: "Cleanup requires confirm=TEST_ONLY"
        }, 403);
      }

      await env.DB.prepare(
        "DELETE FROM task_steps"
      ).run();

      await env.DB.prepare(
        "DELETE FROM tasks"
      ).run();

      return json({
        success: true,
        message: "Test data cleared 🧹"
      });
    }

    // =========================================================
    // DEFAULT MEMORY VIEW
    // =========================================================

    const tasks = await env.DB.prepare(`
      SELECT *
      FROM tasks
      ORDER BY id DESC
    `).all();

    return json({
      hermes: "alive 🚀",
      memory: "connected 🧠",
      tasks: tasks.results
    });
  }
};


// ===========================================================
// AI ROUTER
// ===========================================================

async function callAI(
  env,
  prompt,
  useSearch = false
) {
  // ---------------------------------------------------------
  // PRIMARY: GEMINI
  // ---------------------------------------------------------

  try {
    const response = await callGemini(
      env,
      prompt,
      useSearch
    );

    return {
      provider: "gemini",
      text: response.text,
      raw: response.raw
    };

  } catch (geminiError) {

    // -------------------------------------------------------
    // FALLBACK: OPENROUTER FREE
    // -------------------------------------------------------

    try {
      const response = await callOpenRouter(
        env,
        prompt
      );

      return {
        provider: "openrouter/free",
        text: response.text,
        raw: response.raw,
        fallback_from: "gemini"
      };

    } catch (openRouterError) {

      throw new Error(
        `All free AI providers failed. ` +
        `Gemini: ${geminiError.message} | ` +
        `OpenRouter: ${openRouterError.message}`
      );
    }
  }
}


// ===========================================================
// GEMINI
// ===========================================================

async function callGemini(
  env,
  prompt,
  useSearch = false
) {
  const body = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ]
  };

  if (useSearch) {
    body.tools = [
      {
        google_search: {}
      }
    ];
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Gemini API request failed"
    );
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") ||
    "Gemini returned no text.";

  return {
    text,
    raw: data
  };
}


// ===========================================================
// OPENROUTER FREE
// ===========================================================

async function callOpenRouter(
  env,
  prompt
) {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured"
    );
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization":
          `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer":
          "https://hermes-business-agent.aashishatghaziabad.workers.dev",
        "X-Title":
          "Hermes Business Agent"
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "OpenRouter API request failed"
    );
  }

  const text =
    data?.choices?.[0]?.message?.content ||
    "OpenRouter returned no text.";

  return {
    text,
    raw: data
  };
}


// ===========================================================
// STEP EXECUTOR
// ===========================================================

async function executeStep(
  env,
  task,
  step
) {
  await env.DB.prepare(`
    UPDATE task_steps
    SET status = 'running',
        attempts = attempts + 1
    WHERE id = ?
  `)
    .bind(step.id)
    .run();

  try {
    const response = await callAI(
      env,
      `
You are Hermes executing one step of an autonomous task.

OVERALL TASK:
${task.task}

CURRENT STEP:
${step.action}

Use available web/search capabilities when current or factual
information is required.

Execute the step as helpfully as possible.

Clearly distinguish:
- facts you found
- analysis
- things you could not verify

Return a concise execution result.
      `,
      true
    );

    await env.DB.prepare(`
      UPDATE task_steps
      SET status = 'completed',
          result = ?
      WHERE id = ?
    `)
      .bind(response.text, step.id)
      .run();

    return {
      success: true,
      step_id: step.id,
      step_number: step.step_number,
      status: "completed",
      provider: response.provider,
      result: response.text
    };

  } catch (error) {
    const newAttempts =
      step.attempts + 1;

    const nextStatus =
      newAttempts < 3
        ? "pending"
        : "failed";

    await env.DB.prepare(`
      UPDATE task_steps
      SET status = ?,
          result = ?
      WHERE id = ?
    `)
      .bind(
        nextStatus,
        error.message,
        step.id
      )
      .run();

    await env.DB.prepare(`
      UPDATE tasks
      SET status = ?
      WHERE id = ?
    `)
      .bind(
        nextStatus === "pending"
          ? "planned"
          : "failed",
        task.id
      )
      .run();

    return {
      success: false,
      step_id: step.id,
      step_number: step.step_number,
      status:
        nextStatus === "pending"
          ? "retrying"
          : "failed",
      attempts: newAttempts,
      error: error.message
    };
  }
}


// ===========================================================
// JSON RESPONSE HELPER
// ===========================================================

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json"
      }
    }
  );
}


// ===========================================================
// CLEAN GEMINI JSON
// ===========================================================

function cleanJson(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
