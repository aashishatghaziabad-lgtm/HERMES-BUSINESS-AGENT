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

try {
  await env.DB.prepare(
    "ALTER TABLE task_steps ADD COLUMN sources TEXT"
  ).run();
} catch (e) {
  // Column already exists
}

try {
  await env.DB.prepare(
    "ALTER TABLE task_steps ADD COLUMN tool_calls INTEGER DEFAULT 0"
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
    // POST /plan?task_id=20
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
    // POST /step?task_id=20
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

      const stepResponse = await executeStep(
        env,
        task,
        step
      );

      return json({
        ...stepResponse,
        task_id: task.id
      }, stepResponse.success ? 200 : 500);
    }


    // =========================================================
    // RUN TASK
    // POST /run-task?task_id=20
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

      if (!steps.results || steps.results.length === 0) {
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
          "UPDATE tasks SET status = 'completed', result = ? WHERE id = ?"
        )
          .bind(stepResponse.result || "", task.id)
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

        const result = await searchWeb(
          env,
          data.query
        );

        return json({
          success: true,
          tool: "web_search",
          ...result
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
    // GET /steps?task_id=20
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
// WEB SEARCH
// ===========================================================

async function searchWeb(env, query) {

  if (!env.TAVILY_API_KEY) {
    throw new Error(
      "TAVILY_API_KEY is not configured"
    );
  }

  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: query.trim(),
        search_depth: "basic",
        max_results: 5,
        include_answer: false
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

  return {
    query: query.trim(),
    results: result.results || []
  };
}


// ===========================================================
// HERMES AGENT
// ===========================================================

async function runAgent(
  env,
  task,
  stepAction
) {

  const maxToolCalls = 3;

  let conversation = `
You are Hermes, an autonomous business research assistant.

TASK:
${task}

CURRENT STEP:
${stepAction}

You have ONE external tool:

WEB_SEARCH

The Worker executes this tool.

============================================================
SEARCH PROTOCOL
============================================================

If current web information is needed, return ONLY:

{"action":"search","query":"SEARCH QUERY"}

Do NOT search by yourself.

Do NOT claim you searched unless the Worker supplied search results.

============================================================
FINAL PROTOCOL
============================================================

When you have enough information, return ONLY:

{"action":"final","answer":"FINAL ANSWER"}

============================================================
STRICT RULES
============================================================

- Return JSON only.
- Never output <tool_call>.
- Never output User Safety.
- Never classify the request as safe or unsafe.
- Never invent search results.
- Never pretend an external action occurred.
- Use the search results supplied by the Worker.
`;

  for (
    let attempt = 0;
    attempt < maxToolCalls;
    attempt++
  ) {

    const ai = await callAI(
      env,
      conversation,
      false
    );

    const text = (
      ai.text || ""
    ).trim();

    let decision;

    try {

      decision = JSON.parse(
        cleanJson(text)
      );

    } catch (error) {

      // Give the model one recovery instruction.
      if (attempt < maxToolCalls - 1) {

        conversation += `

Your previous response was not valid JSON.

You MUST return exactly one of:

{"action":"search","query":"..."}

OR

{"action":"final","answer":"..."}

Return JSON only.
`;

        continue;
      }

      return {
        success: false,
        provider: ai.provider,
        answer: text,
        tool_calls: attempt,
        protocol_error: true
      };
    }


    // ========================================================
    // SEARCH
    // ========================================================

    if (
      decision.action === "search" &&
      typeof decision.query === "string" &&
      decision.query.trim()
    ) {

      const searchResult = await searchWeb(
        env,
        decision.query
      );
      const sources = (searchResult.results || []).map(
  result => ({
    title: result.title || "",
    url: result.url || "",
    content: result.content || ""
  })
);
      conversation += `

SOURCE EVIDENCE:

${JSON.stringify(sources)}
`;

      conversation += `

============================================================
REAL WEB SEARCH RESULTS
============================================================

${JSON.stringify(searchResult)}

============================================================

These results came from the Worker.

Analyze them.

If more research is needed:

{"action":"search","query":"..."}

Otherwise:

{"action":"final","answer":"..."}
`;

      continue;
    }


    // ========================================================
    // FINAL
    // ========================================================

    if (
      decision.action === "final" &&
      typeof decision.answer === "string"
    ) {

      return {
        success: true,
        provider: ai.provider,
        answer: decision.answer,
        tool_calls: attempt
      };
    }


    // ========================================================
    // INVALID ACTION
    // ========================================================

    conversation += `

Invalid action.

Return ONLY:

{"action":"search","query":"..."}

or:

{"action":"final","answer":"..."}
`;

  }


  return {
    success: false,
    provider: "agent",
    answer: "Maximum web-search limit reached.",
    tool_calls: maxToolCalls
  };
}


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

  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not configured"
    );
  }

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

  // We deliberately do NOT use Google's search tool here.
  // Hermes controls web search through Tavily.
  //
  // This keeps the tool architecture consistent and makes
  // the Worker responsible for executing tools.

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
    "";

  if (!text) {
    throw new Error(
      "Gemini returned no text"
    );
  }

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
    "";

  if (!text) {
    throw new Error(
      "OpenRouter returned no text"
    );
  }

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

    // ========================================================
    // IMPORTANT:
    // The old code called callAI() here directly.
    //
    // Now executeStep() calls runAgent().
    //
    // This is the connection that was missing.
    // ========================================================

    const response = await runAgent(
      env,
      task.task,
      step.action
    );

    if (!response.success) {
      throw new Error(
        response.answer ||
        "Agent execution failed"
      );
    }


    await env.DB.prepare(`
      UPDATE task_steps
      SET status = 'completed',
          result = ?
      WHERE id = ?
    `)
      .bind(
        response.answer,
        step.id
      )
      .run();


    return {
      success: true,
      step_id: step.id,
      step_number: step.step_number,
      status: "completed",
      provider: response.provider,
      tool_calls: response.tool_calls,
      result: response.answer
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
// CLEAN AI JSON
// ===========================================================

function cleanJson(text) {

  if (!text) {
    return "";
  }

  let cleaned = text.trim();

  // Remove markdown code fences
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Find the first JSON object
  const firstBrace = cleaned.indexOf("{");

  if (firstBrace === -1) {
    return cleaned;
  }

  // Find the matching closing brace.
  // This prevents extra model text after the JSON
  // from breaking JSON.parse().
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let i = firstBrace;
    i < cleaned.length;
    i++
  ) {

    const char = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth++;
    }

    if (char === "}") {
      depth--;

      if (depth === 0) {
        return cleaned.substring(
          firstBrace,
          i + 1
        ).trim();
      }
    }
  }

  return cleaned.substring(firstBrace).trim();
}
