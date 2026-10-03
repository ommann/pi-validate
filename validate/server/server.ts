import { join, resolve } from "node:path";
import { Validation, agentReport } from "./core.ts";
import { projectPath } from "./routes.ts";

export async function startServer(cwd = process.cwd(), port = 3210, options: { persist?: boolean } = {}) {
  // Cache the promise so simultaneous first requests share one project instance.
  const sessions = new Map<string, Promise<Validation>>();
  let stopping = false;
  function session(path: string) {
    const cwd = resolve(path);
    let pending = sessions.get(cwd);
    if (!pending) {
      pending = Validation.create(cwd, options);
      sessions.set(cwd, pending);
      pending.catch(() => sessions.delete(cwd));
    }
    return pending;
  }
  return Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 0, maxRequestBodySize: 64 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
      if (!["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port) !== server.port) return json({ error: "Invalid host" }, 403);
      const origin = request.headers.get("Origin");
      if ((origin && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return json({ error: "Cross-origin request rejected" }, 403);
      const asset = (name: string) => new Response(Bun.file(join(import.meta.dir, "..", "ui", name)), {
        headers: { ...headers, "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" },
      });
      if (request.method === "GET") {
        if (url.pathname === "/api/health") return json({ service: "validate", version: 1 });
        if (url.pathname === "/") return Response.redirect(new URL(projectPath(resolve(cwd)), url), 302);
        const assets = new Map([["/app.js", "app.js"], ["/ansi.js", "ansi.js"], ["/plan.js", "plan.js"], ["/style.css", "style.css"]]);
        const name = assets.get(url.pathname);
        if (name) return asset(name);
      }
      if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
      if (request.method === "POST" && (request.headers.get("X-Validate") !== "1" || !request.headers.get("Content-Type")?.startsWith("application/json"))) return json({ error: "JSON and X-Validate header required" }, 403);
      if (stopping) return json({ error: "Server is stopping" }, 503);
      if (request.method === "POST" && url.pathname === "/api/shutdown") {
        stopping = true;
        const projects = await Promise.allSettled(sessions.values());
        if (projects.some(project => project.status === "fulfilled" && project.value.busy)) {
          stopping = false;
          return json({ error: "A project is busy; stop the server after it finishes" }, 409);
        }
        // Let the response finish before closing connections.
        setTimeout(() => { void server.stop(true); }, 100);
        return json({ stopped: true });
      }
      if (!url.pathname.startsWith("/projects/")) return json({ error: "Not found" }, 404);
      try {
        const match = url.pathname.match(/^(\/projects\/.*\/)(api\/(?:state|plan|detect|run))$/);
        if (!match) {
          if (request.method !== "GET") return json({ error: "Not found" }, 404);
          if (!url.pathname.endsWith("/")) return Response.redirect(new URL(url.pathname + "/", url), 302);
          await session(decodeURIComponent(url.pathname.slice("/projects".length, -1)) || "/");
          return asset("index.html");
        }
        const project = await session(decodeURIComponent(match[1]!.slice("/projects".length, -1)) || "/");
        if (stopping) return json({ error: "Server is stopping" }, 503);
        const action = match[2];
        if (request.method === "GET") return action === "api/state" ? json(project.snapshot()) : json({ error: "Not found" }, 404);
        if (project.busy) return json({ error: "Validation is busy" }, 409);
        const body = await request.json();
        if (stopping) return json({ error: "Server is stopping" }, 503);
        // The core acquires its per-project busy flag synchronously.
        switch (action) {
          case "api/plan": await project.configure(body); return json(project.snapshot());
          case "api/detect": await project.detect(); return json(project.snapshot());
          case "api/run": {
            if (!["agent", "user"].includes(body?.caller)) throw new Error("Caller must be agent or user");
            const run = await project.run(body.caller);
            return json(body.caller === "agent" ? agentReport(run) : { id: run.id });
          }
          default: return json({ error: "Not found" }, 404);
        }
      } catch (error) {
        return json({ error: String(error) }, String(error).includes("Validation is busy") ? 409 : 400);
      }
    },
  });
}

if (import.meta.main) {
  try {
    const port = Number(process.env.PORT ?? 3210);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
    const server = await startServer(process.argv[2] ?? process.cwd(), port);
    console.log(`Validation UI: ${server.url}`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
