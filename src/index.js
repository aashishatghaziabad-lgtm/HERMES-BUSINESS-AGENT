export default {
  async fetch(request, env) {
    // Create memory table
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Add result column if this table already existed
    try {
      await env.DB.prepare(
        "ALTER TABLE tasks ADD COLUMN result TEXT"
      ).run();
    } catch (e) {
      // Column already exists — that's okay
    }

    // Execute one pending task
    if (request.method === "POST" && new URL(request.url).pathname === "/run") {
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

      // Temporary executor test
      const result = `Hermes received and processed: ${task.task}`;

      await env.DB.prepare(
        "UPDATE tasks SET status = 'completed', result = ? WHERE id = ?"
      ).bind(result, task.id).run();

      return new Response(
        JSON.stringify({
          success: true,
          task_id: task.id,
          status: "completed",
          result
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // Normal GET = show memory
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
