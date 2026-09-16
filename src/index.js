export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // DATABASE SETUP
    // =========================================================

    // ---------------------------------------------------------
    // TASKS TABLE
    // ---------------------------------------------------------

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();


    // ---------------------------------------------------------
    // TASK STEPS TABLE
    // IMPORTANT:
    // sources + tool_calls are included here so a fresh
    // database gets the complete schema immediately.
    // ---------------------------------------------------------

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS task_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        step_number INTEGER NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        sources TEXT,
        tool_calls INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `).run();


    // =========================================================
    // DATABASE MIGRATIONS
    // For existing databases
    // =========================================================

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
        .bind(
          data.task.trim(),
          "pending"
        )
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

      const taskId =
        url.searchParams.get("task_id");


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


        const cleanResult =
          cleanJson(response.text);

        const plan =
          JSON.parse(cleanResult);


        if (
          !plan.steps ||
          !Array.isArray(plan.steps) ||
          plan.steps.length === 0
        ) {
          throw new Error(
            "AI returned an invalid plan"
          );
        }


        for (const step of plan.steps) {

          await env.DB.prepare(`
            INSERT INTO task_steps
            (
              task_id,
              step_number,
              action,
              status
            )
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
          .bind(
            cleanResult,
            task.id
          )
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
          .bind(
            error.message,
            task.id
          )
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

      const taskId =
        url.searchParams.get("task_id");


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


      const stepResponse =
        await executeStep(
          env,
          task,
          step
        );


      return json(
        {
          ...stepResponse,
          task_id: task.id
        },
        stepResponse.success ? 200 : 500
      );
    }


    // =========================================================
    // RUN TASK
    // POST /run-task?task_id=20
    // =========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/run-task"
    ) {

      const taskId =
        url.searchParams.get("task_id");


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


      if (
        !steps.results ||
        steps.results.length === 0
      ) {
        return json({
          success: false,
          error: "Task has no planned steps"
        }, 400);
      }


      const pendingSteps =
        steps.results.filter(
          step => step.status === "pending"
        );


      const failedSteps =
        steps.results.filter(
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


      const step =
        pendingSteps[0];


      const stepResponse =
        await executeStep(
          env,
          task,
          step
        );


      if (!stepResponse.success) {
        return json(
          stepResponse,
          500
        );
      }


      const remaining =
        await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM task_steps
          WHERE task_id = ?
          AND status != 'completed'
        `)
          .bind(task.id)
          .first();


      if (
        Number(remaining.count) === 0
      ) {

        await env.DB.prepare(
          "UPDATE tasks SET status = 'completed', result = ? WHERE id = ?"
        )
          .bind(
            stepResponse.result || "",
            task.id
          )
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
        remaining_steps:
          Number(remaining.count)
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

        const result =
          await searchWeb(
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

      const taskId =
        url.searchParams.get("task_id");


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


      if (
        confirmation !== "TEST_ONLY"
      ) {
        return json({
          success: false,
          error:
            "Cleanup requires confirm=TEST_ONLY"
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

    const tasks =
      await env.DB.prepare(`
        SELECT *
        FROM tasks
        ORDER BY id DESC
      `)
        .all();


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
function scoreSourceQuality(result, query) {

  const url =
    String(result?.url || "").toLowerCase();

  const title =
    String(result?.title || "").toLowerCase();

  const content =
    String(result?.content || "").toLowerCase();

  const text =
    `${title} ${content} ${url}`;

  let score = 0;


  // Official / primary sources
  if (
    url.includes("amazon.com") ||
    url.includes("sell.amazon.com") ||
    url.includes("sellercentral.amazon")
  ) {
    score += 30;
  }


  // Strong community evidence
  if (
    url.includes("reddit.com")
  ) {
    score += 15;
  }


  // Established business / research sources
  const qualityDomains = [
    "forbes.com",
    "reuters.com",
    "economictimes.indiatimes.com",
    "moneycontrol.com",
    "business-standard.com",
    "inc42.com",
    "entrackr.com",
    "yourstory.com",
    "statista.com",
    "ibef.org"
  ];

  for (const domain of qualityDomains) {

    if (url.includes(domain)) {
      score += 20;
      break;
    }
  }


  // Search relevance
  const queryWords =
    query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length >= 4);

  let matches = 0;

  for (const word of queryWords) {

    if (text.includes(word)) {
      matches++;
    }
  }

  if (queryWords.length > 0) {

    score += Math.min(
      30,
      Math.round(
        (matches / queryWords.length) * 30
      )
    );
  }


  // Penalize obvious low-value pages
  if (
    url.includes("/watch") ||
    url.includes("youtube.com") ||
    url.includes("/channel/") ||
    url.includes("/search") ||
    url.includes("/tag/") ||
    url.includes("/category/")
  ) {
    score -= 15;
  }


  // Reddit subreddit homepage is weak evidence
  if (
    url.includes("reddit.com/r/") &&
    !url.includes("/comments/")
  ) {
    score -= 20;
  }


  return Math.max(
    0,
    Math.min(100, score)
  );
}
async function searchWeb(
  env,
  query
) {

  if (!env.TAVILY_API_KEY) {
    throw new Error(
      "TAVILY_API_KEY is not configured"
    );
  }

  const cleanQuery = query.trim();

  if (!cleanQuery) {
    throw new Error(
      "Search query cannot be empty"
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
        api_key:
          env.TAVILY_API_KEY,

        query:
          cleanQuery,

        search_depth:
          "advanced",

        max_results:
          10,

        include_answer:
          false,

        include_raw_content:
          false,

        include_images:
          false
      })
    }
  );

  const result =
    await response.json();

  if (!response.ok) {
    throw new Error(
      result?.detail ||
      result?.error ||
      "Tavily search failed"
    );
  }

  const rawResults =
    Array.isArray(result.results)
      ? result.results
      : [];

  const seenUrls =
  new Set();

const seenEvidence =
  new Set();

const uniqueResults =
  rawResults.filter((item) => {

    const url =
      String(item?.url || "")
        .trim();

    const title =
      String(item?.title || "")
        .trim()
        .toLowerCase();

    const content =
      String(item?.content || "")
        .trim()
        .toLowerCase();

    if (!url) {
      return false;
    }


    // Exact URL duplicate
    if (seenUrls.has(url)) {
      return false;
    }

    seenUrls.add(url);


    /*
     * Detect the same evidence appearing
     * on different URLs/subreddits.
     *
     * We normalize the title and content
     * so small formatting differences don't
     * create fake independent sources.
     */
    const evidenceKey =
      `${title}|${content}`
        .replace(/\s+/g, " ")
        .trim();


    if (
      evidenceKey &&
      seenEvidence.has(evidenceKey)
    ) {
      return false;
    }

    if (evidenceKey) {
      seenEvidence.add(evidenceKey);
    }


    return true;
  });
  const enrichedResults =
    uniqueResults.map((item, index) => {

      let domain = "";

      try {
        domain =
          new URL(item.url).hostname
            .replace(/^www\./, "");
      } catch {
        domain = "";
      }

      const qualityScore =
        scoreSourceQuality(
          item,
          cleanQuery
        );

      return {
        rank:
          index + 1,

        title:
          item.title || "",

        url:
          item.url,

        domain:
          domain,

        content:
          item.content || "",

        tavily_score:
          typeof item.score === "number"
            ? item.score
            : null,

        quality_score:
          qualityScore
      };
    });

  enrichedResults.sort(
    (a, b) =>
      b.quality_score -
      a.quality_score
  );

  enrichedResults.forEach(
    (item, index) => {
      item.rank = index + 1;
    }
  );

  return {
    success:
      true,

    tool:
      "web_search",

    query:
      cleanQuery,

    result_count:
      enrichedResults.length,

    results:
      enrichedResults
  };
}// ===========================================================
// HERMES AGENT
// ===========================================================
async function evaluateSearchResults(env, researchQuestion, results) {
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  const compactResults = results.map((result, index) => ({
    id: index,
    title: result.title || "",
    url: result.url || "",
    domain: result.domain || "",
    content: String(result.content || "").slice(0, 3500),
  }));

  const prompt = `
You are the Research Evidence Evaluator for Hermes Business Agent.

Your job is NOT to summarize the research.

Your job is to inspect each web source and classify its research value.

RESEARCH QUESTION:
${researchQuestion}

For EVERY source, evaluate:

1. relevant
   - true if the source directly helps answer the research question.
   - false if it is mostly unrelated.

2. relevance_score
   - integer from 0 to 100.

3. source_quality
   - integer from 0 to 100.
   - Consider:
     * official/primary source
     * established publication
     * credible industry research
     * community discussion
     * unknown/low-quality source

4. evidence_strength
   - "high", "medium", or "low"

5. recency
   - "recent", "older", or "unknown"
   - Only call something recent if the source provides enough date/context to justify it.

6. source_type
   Choose ONE:
   - official
   - government
   - research
   - established_media
   - industry
   - community
   - company
   - blog
   - unknown

7. india_relevance
   - integer from 0 to 100.
   - How directly does this evidence apply to Indian Amazon sellers?

8. evidence
   - Give 1 to 3 short factual evidence points actually supported by the source.
   - Do NOT invent information.

9. claims
   - List the major claims supported by this source.
   - Keep each claim short.

10. duplicate_group
   - Assign the same group number when multiple sources appear to report substantially the same underlying information.
   - Use 0 if the source appears independent.

11. contradiction
   - true only when the source appears to contradict another source or commonly reported evidence in the supplied results.
   - Otherwise false.

12. reason
   - Briefly explain the evaluation.

IMPORTANT RULES:
- Do not reward a source merely because it agrees with other sources.
- Repetition is NOT independent confirmation.
- Official and primary sources generally deserve higher source_quality.
- Community discussions can provide useful evidence of real user pain but should not automatically be treated as authoritative facts.
- Company marketing pages can explain product capabilities but should not automatically be treated as independent evidence.
- Do not invent publication dates.
- Do not infer India relevance merely because Amazon is mentioned.
- Distinguish firsthand reports from factual/authoritative evidence.
- Return ONLY valid JSON.
- Return one evaluation object for EVERY input source.

Required JSON format:

{
  "results": [
    {
      "id": 0,
      "relevant": true,
      "relevance_score": 90,
      "source_quality": 75,
      "evidence_strength": "medium",
      "recency": "recent",
      "source_type": "community",
      "india_relevance": 85,
      "evidence": [
        "Short evidence point"
      ],
      "claims": [
        "Short supported claim"
      ],
      "duplicate_group": 0,
      "contradiction": false,
      "reason": "Brief explanation"
    }
  ]
}

SOURCES:
${JSON.stringify(compactResults)}
`;

  try {
    const aiResponse = await callAI(env, prompt);

    const parsed = cleanJson(aiResponse);

    if (
      !parsed ||
      !Array.isArray(parsed.results)
    ) {
      console.warn(
        "Research evaluator returned invalid JSON structure."
      );

      return results.map(result => ({
        ...result,
        relevant: true,
        relevance_score: 50,
        source_quality: result.quality_score || 50,
        evidence_strength: "low",
        recency: "unknown",
        source_type: "unknown",
        india_relevance: 50,
        evidence: [],
        claims: [],
        duplicate_group: 0,
        contradiction: false,
        relevance_reason:
          "Evaluator returned an invalid response; original source retained."
      }));
    }

    const decisions = new Map();

    for (const decision of parsed.results) {
      if (
        decision &&
        Number.isInteger(decision.id)
      ) {
        decisions.set(decision.id, decision);
      }
    }

    return results.map((result, index) => {
      const decision = decisions.get(index);

      if (!decision) {
        return {
          ...result,
          relevant: false,
          relevance_score: 0,
          source_quality: result.quality_score || 0,
          evidence_strength: "low",
          recency: "unknown",
          source_type: "unknown",
          india_relevance: 0,
          evidence: [],
          claims: [],
          duplicate_group: 0,
          contradiction: false,
          relevance_reason:
            "Evaluator did not return a decision for this source."
        };
      }

      return {
        ...result,

        relevant:
          decision.relevant === true,

        relevance_score:
          Number.isFinite(
            Number(decision.relevance_score)
          )
            ? Math.max(
                0,
                Math.min(
                  100,
                  Number(decision.relevance_score)
                )
              )
            : 0,

        source_quality:
          Number.isFinite(
            Number(decision.source_quality)
          )
            ? Math.max(
                0,
                Math.min(
                  100,
                  Number(decision.source_quality)
                )
              )
            : (result.quality_score || 0),

        evidence_strength:
          ["high", "medium", "low"].includes(
            decision.evidence_strength
          )
            ? decision.evidence_strength
            : "low",

        recency:
          ["recent", "older", "unknown"].includes(
            decision.recency
          )
            ? decision.recency
            : "unknown",

        source_type:
          typeof decision.source_type === "string"
            ? decision.source_type
            : "unknown",

        india_relevance:
          Number.isFinite(
            Number(decision.india_relevance)
          )
            ? Math.max(
                0,
                Math.min(
                  100,
                  Number(decision.india_relevance)
                )
              )
            : 0,

        evidence:
          Array.isArray(decision.evidence)
            ? decision.evidence
                .filter(
                  item =>
                    typeof item === "string"
                )
                .slice(0, 3)
            : [],

        claims:
          Array.isArray(decision.claims)
            ? decision.claims
                .filter(
                  item =>
                    typeof item === "string"
                )
                .slice(0, 10)
            : [],

        duplicate_group:
          Number.isInteger(
            decision.duplicate_group
          )
            ? decision.duplicate_group
            : 0,

        contradiction:
          decision.contradiction === true,

        relevance_reason:
          typeof decision.reason === "string"
            ? decision.reason
            : ""
      };
    });

  } catch (error) {
    console.error(
      "Research evaluator failed:",
      error.message
    );

    // Fail-open:
    // Keep the original search results usable even if
    // the secondary evaluation model fails.
    return results.map(result => ({
      ...result,
      relevant: true,
      relevance_score:
        result.quality_score || 50,
      source_quality:
        result.quality_score || 50,
      evidence_strength: "low",
      recency: "unknown",
      source_type: "unknown",
      india_relevance: 50,
      evidence: [],
      claims: [],
      duplicate_group: 0,
      contradiction: false,
      relevance_reason:
        "Research evaluator unavailable; original search result retained."
    }));
  }
}
async function runAgent(env, task, stepAction) {

  const maxToolCalls = 3;

  let collectedSources = [];
  let totalToolCalls = 0;

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
- Base factual claims on supplied search evidence whenever possible.
`;

  for (let attempt = 0; attempt < maxToolCalls + 2; attempt++) {

    const ai = await callAI(
      env,
      conversation,
      false
    );

    const text = (ai.text || "").trim();

    let decision;

    try {

      decision = JSON.parse(
        cleanJson(text)
      );

    } catch (error) {

      conversation += `

Your previous response was invalid.

Return ONLY valid JSON.

If web research is required:
{"action":"search","query":"..."}

If enough information is available:
{"action":"final","answer":"..."}

JSON ONLY.
`;

      continue;
    }

    // ========================================================
    // SEARCH REQUEST
    // ========================================================

    if (
      decision.action === "search" &&
      typeof decision.query === "string" &&
      decision.query.trim()
    ) {

      if (totalToolCalls >= maxToolCalls) {

        conversation += `

You have reached the maximum number of web searches.

Use the evidence already provided and produce the final answer now.

Return ONLY:

{"action":"final","answer":"..."}
`;

        continue;
      }

      totalToolCalls++;

      let searchResult;

      try {

        searchResult = await searchWeb(
          env,
          decision.query
        );

      } catch (searchError) {

        conversation += `

============================================================
WEB SEARCH ERROR
============================================================

The Worker attempted this search:

${decision.query}

But the search tool returned an error:

${searchError.message}

The search was NOT successful.

You may:
1. Try a different search query, OR
2. Use previously supplied evidence and produce the final answer.

Return ONLY:

{"action":"search","query":"..."}

OR:

{"action":"final","answer":"..."}

Do not claim that the failed search produced results.
`;

        continue;
      }

      const results = searchResult?.results || [];
const evaluatedResults =
  await evaluateSearchResults(
    env,
    `${task}\n${stepAction}`,
    results
  ); 
      const relevantResults = evaluatedResults.filter(
  result => result.relevant === true
);
      const newSources = relevantResults.map(result => ({
  title: result.title || "",
  url: result.url || "",
  content: result.content || "",

  relevance_score:
    result.relevance_score ?? null,

  source_quality:
    result.source_quality ?? null,

  evidence_strength:
    result.evidence_strength || "low",

  recency:
    result.recency || "unknown",

  source_type:
    result.source_type || "unknown",

  india_relevance:
    result.india_relevance ?? null,

  evidence:
    Array.isArray(result.evidence)
      ? result.evidence
      : [],

  claims:
    Array.isArray(result.claims)
      ? result.claims
      : [],

  duplicate_group:
    result.duplicate_group ?? 0,

  contradiction:
    result.contradiction === true,

  relevance_reason:
    result.relevance_reason || ""
})).filter(source => source.url);      
      for (const source of newSources) {

        const exists = collectedSources.some(
          existing =>
            existing.url === source.url
        );

        if (!exists) {
          collectedSources.push(source);
        }
      }

      conversation += `

============================================================
REAL WEB SEARCH RESULTS
============================================================

SEARCH QUERY:
${decision.query}

RESULT COUNT:
${evaluatedResults.length}

RESULTS:
${JSON.stringify(relevantResults)}

SOURCE EVIDENCE:
${JSON.stringify(newSources)}

============================================================

These results came directly from the Worker.

Analyze them.

Do not invent facts.

If more research is genuinely required and searches remain available:

{"action":"search","query":"..."}

Otherwise:

{"action":"final","answer":"..."}
`;

      continue;
    }

    // ========================================================
    // FINAL ANSWER
    // ========================================================

    if (
      decision.action === "final" &&
      typeof decision.answer === "string" &&
      decision.answer.trim()
    ) {

      return {
        success: true,
        provider: ai.provider,
        answer: decision.answer,
        tool_calls: totalToolCalls,
        sources: collectedSources
      };
    }

    // ========================================================
    // INVALID ACTION
    // ========================================================

    conversation += `

Your previous JSON used an invalid action.

Return ONLY one of:

{"action":"search","query":"..."}

OR:

{"action":"final","answer":"..."}

JSON ONLY.
`;
  }

  return {
    success: false,
    provider: "agent",
    answer: "Hermes could not complete the agent loop within the allowed attempts.",
    tool_calls: totalToolCalls,
    sources: collectedSources
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

    const response =
      await callGemini(
        env,
        prompt,
        useSearch
      );


    return {
      provider:
        "gemini",

      text:
        response.text,

      raw:
        response.raw
    };


  } catch (geminiError) {


    // -------------------------------------------------------
    // FALLBACK: OPENROUTER FREE
    // -------------------------------------------------------

    try {

      const response =
        await callOpenRouter(
          env,
          prompt
        );


      return {
        provider:
          "openrouter/free",

        text:
          response.text,

        raw:
          response.raw,

        fallback_from:
          "gemini"
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
            text:
              prompt
          }
        ]
      }
    ]
  };


  // Hermes controls web search through Tavily.
  // We deliberately do not use Google's search tool here.


  const response =
    await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-goog-api-key":
            env.GEMINI_API_KEY
        },

        body:
          JSON.stringify(body)
      }
    );


  const data =
    await response.json();


  if (!response.ok) {

    throw new Error(
      data?.error?.message ||
      "Gemini API request failed"
    );
  }


  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map(
        part =>
          part.text || ""
      )
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


  const response =
    await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Authorization":
            `Bearer ${env.OPENROUTER_API_KEY}`,

          "HTTP-Referer":
            "https://hermes-business-agent.aashishatghaziabad.workers.dev",

          "X-Title":
            "Hermes Business Agent"
        },

        body:
          JSON.stringify({
            model:
              "openrouter/free",

            messages: [
              {
                role:
                  "user",

                content:
                  prompt
              }
            ]
          })
      }
    );


  const data =
    await response.json();


  if (!response.ok) {

    throw new Error(
      data?.error?.message ||
      "OpenRouter API request failed"
    );
  }


  const message =
  data?.choices?.[0]?.message || {};

const text =
  typeof message.content === "string"
    ? message.content.trim()
    : "";

if (!text) {
  throw new Error(
    `OpenRouter returned no usable text. ` +
    `Response: ${JSON.stringify(data).slice(0, 2000)}`
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
    // REAL HERMES AGENT
    // ========================================================

    const response =
      await runAgent(
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


    // ========================================================
    // SAVE RESULT + SOURCES + TOOL CALLS
    // ========================================================

    await env.DB.prepare(`
      UPDATE task_steps
      SET status = 'completed',
          result = ?,
          sources = ?,
          tool_calls = ?
      WHERE id = ?
    `)
      .bind(

        response.answer,

        JSON.stringify(
          response.sources || []
        ),

        response.tool_calls || 0,

        step.id
      )
      .run();


    return {

      success:
        true,

      step_id:
        step.id,

      step_number:
        step.step_number,

      status:
        "completed",

      provider:
        response.provider,

      tool_calls:
        response.tool_calls || 0,

      sources:
        response.sources || [],

      result:
        response.answer
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

      success:
        false,

      step_id:
        step.id,

      step_number:
        step.step_number,

      status:
        nextStatus === "pending"
          ? "retrying"
          : "failed",

      attempts:
        newAttempts,

      error:
        error.message
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
        "content-type":
          "application/json"
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


  let cleaned =
    text.trim();


  // ---------------------------------------------------------
  // Remove markdown code fences
  // ---------------------------------------------------------

  cleaned =
    cleaned
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();


  // ---------------------------------------------------------
  // Find first JSON object
  // ---------------------------------------------------------

  const firstBrace =
    cleaned.indexOf("{");


  if (
    firstBrace === -1
  ) {
    return cleaned;
  }


  // ---------------------------------------------------------
  // Find matching closing brace
  // ---------------------------------------------------------

  let depth = 0;

  let inString = false;

  let escaped = false;


  for (
    let i = firstBrace;
    i < cleaned.length;
    i++
  ) {

    const char =
      cleaned[i];


    if (escaped) {

      escaped =
        false;

      continue;
    }


    if (
      char === "\\"
    ) {

      escaped =
        true;

      continue;
    }


    if (
      char === '"'
    ) {

      inString =
        !inString;

      continue;
    }


    if (inString) {
      continue;
    }


    if (
      char === "{"
    ) {

      depth++;
    }


    if (
      char === "}"
    ) {

      depth--;


      if (
        depth === 0
      ) {

        return cleaned
          .substring(
            firstBrace,
            i + 1
          )
          .trim();
      }
    }
  }


  return cleaned
    .substring(firstBrace)
    .trim();
}
