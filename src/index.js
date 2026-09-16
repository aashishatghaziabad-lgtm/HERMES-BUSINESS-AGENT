export default {
  async fetch(request, env) {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    if (request.method === "POST") {
      const data = await request.json();

      await env.DB.prepare(
        "INSERT INTO tasks (task, status) VALUES (?, ?)"
      ).bind(data.task, "pending").run();

      return new Response(
        JSON.stringify({
          success: true,
          message: "Task saved to Hermes memory 🧠"
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

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
