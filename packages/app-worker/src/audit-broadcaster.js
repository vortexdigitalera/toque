/**
 * AuditLogBroadcaster — Durable Object for real-time audit log streaming.
 *
 * Maintains a set of WebSocket connections from the toqueui dashboard
 * and broadcasts new audit log entries to all connected clients.
 *
 * Replaces Supabase Realtime (postgres_changes subscription) for the
 * audit_logs table.
 */

export class AuditLogBroadcaster {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Set<WebSocket>} */
    this.sessions = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ─── WebSocket upgrade ──────────────────────────────────────────
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.sessions.add(server);
      server.accept();
      server.addEventListener("close", () => {
        this.sessions.delete(server);
      });
      // Send a welcome message with current connection count
      server.send(JSON.stringify({
        type: "connected",
        subscribers: this.sessions.size,
        timestamp: new Date().toISOString(),
      }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // ─── Broadcast (internal, from the Worker) ─────────────────────
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const entry = await request.json().catch(() => null);
      if (entry) {
        this.broadcast(entry);
      }
      return new Response(JSON.stringify({ ok: true, delivered: this.sessions.size }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ─── Stats ──────────────────────────────────────────────────────
    if (url.pathname === "/stats") {
      return new Response(JSON.stringify({
        ok: true,
        subscribers: this.sessions.size,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Broadcast an audit log entry to all connected WebSocket clients. */
  broadcast(entry) {
    const message = JSON.stringify({
      type: "audit_log",
      entry,
      timestamp: new Date().toISOString(),
    });
    for (const ws of this.sessions) {
      try {
        ws.send(message);
      } catch {
        // Client may have disconnected — remove it
        this.sessions.delete(ws);
      }
    }
  }
}
