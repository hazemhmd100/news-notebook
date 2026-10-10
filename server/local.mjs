import http from "node:http";
import { resolve } from "node:path";
import { createHandler } from "../supabase/functions/_shared/handler.js";
import { localStore } from "./store.mjs";

const port = 8787;
const store = await localStore(resolve(".local/notebook.json"));
const handler = createHandler({
  store,
  demo: true,
  authenticate: async () => "local-demo",
  allowedOrigins: [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
  ],
});
http
  .createServer(async (req, res) => {
    // Loopback only; reject DNS rebinding and browser form-based writes.
    if (
      req.headers.host !== `127.0.0.1:${port}` &&
      req.headers.host !== `localhost:${port}`
    ) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(!["GET", "HEAD"].includes(req.method)
          ? { body: req, duplex: "half" }
          : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "خطأ في الخادم المحلي." }));
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(
      `Local demo API: http://127.0.0.1:${port}/api/health (no cloud authentication)`,
    ),
  );
