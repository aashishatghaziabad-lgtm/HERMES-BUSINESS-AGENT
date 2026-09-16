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

    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).first();

    return new Response(
      JSON.stringify({
        hermes: "alive",
        memory: result ? "connected" : "error",
        database: "hermes-memory"
      }),
      {
        headers: { "content-type": "application/json" }
      }
    );
  }
};
