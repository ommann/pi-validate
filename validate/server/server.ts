import { join, resolve, sep } from "node:path";

import { Validation } from "./core.ts";
import { projectPath } from "./routes.ts";
import { relaunchServer } from "./restart.ts";

export type ServerOptions = {
  persist?: boolean;
  restart?: () => void | Promise<void>;
};

export async function startServer(cwd = process.cwd(), port = 3210, options: ServerOptions = {}) {
  const clientDirectory = join(import.meta.dir, "..", "client", "dist", "validate-client", "browser");

  if (!await Bun.file(join(clientDirectory, "index.html")).exists()) {
    throw new Error("Build the Angular client first: bun run --cwd client build");
  }

  // Cache the promise so simultaneous first requests share one project instance.
  const sessions = new Map<string, Promise<Validation>>();
  const instanceId = crypto.randomUUID();
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

      if (request.method === "GET") {
        if (url.pathname === "/api/health") return json({ service: "validate", version: 1, instanceId });
        if (url.pathname === "/" && resolve(cwd) !== "/") return Response.redirect(new URL(projectPath(resolve(cwd)), url), 302);
        if (url.pathname.startsWith("/client/")) {
          const name = url.pathname.slice("/client/".length);
          const path = resolve(clientDirectory, name);
          if (!path.startsWith(clientDirectory + sep)) return json({ error: "Not found" }, 404);

          // Read the current build, not a startup manifest that becomes stale after rebuilding.
          const file = Bun.file(path);

          return await file.exists() ? new Response(file, { headers }) : json({ error: "Not found" }, 404);
        }
      }

      if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
      if (request.method === "POST" && (request.headers.get("X-Validate") !== "1" || !request.headers.get("Content-Type")?.startsWith("application/json"))) return json({ error: "JSON and X-Validate header required" }, 403);
      if (stopping) return json({ error: "Server is stopping" }, 503);

      if (["/api/shutdown", "/api/restart"].includes(url.pathname)) {
        if (request.method !== "POST") return json({ error: "Not found" }, 404);

        const restart = url.pathname === "/api/restart";
        if (restart && !options.restart) return json({ error: "Restart requires the standalone server process" }, 501);

        stopping = true;
        const projects = await Promise.allSettled(sessions.values());

        if (projects.some(project => project.status === "fulfilled" && project.value.busy)) {
          stopping = false;
          return json({ error: "A project is busy; wait for it to finish" }, 409);
        }

        // Finish the response before releasing the port and launching the new process.
        setTimeout(async () => {
          try {
            await server.stop(true);
            if (restart) await options.restart?.();
          } catch (error) {
            console.error("Server restart failed:", error);
          }
        }, 100);

        return json(restart ? { restarting: true, instanceId } : { stopped: true });
      }

      // Existing agent clients can finish using the old prefix; browser URLs redirect.
      const legacy = url.pathname.startsWith("/projects/");
      const pathname = legacy ? url.pathname.slice("/projects".length) : url.pathname;

      try {
        const match = pathname.match(/^(\/.*\/|\/)(api\/(?:state|plan|detect|run|stop))$/);
        if (!match) {
          if (request.method !== "GET") return json({ error: "Not found" }, 404);
          if (legacy) return Response.redirect(new URL(pathname, url), 302);

          await session(decodeURIComponent(pathname.replace(/\/+$/, "")) || "/");
          if (!pathname.endsWith("/")) return Response.redirect(new URL(pathname + "/", url), 302);
          // CDK inserts its own styles. Authorize them with a per-response nonce.
          const nonce = crypto.randomUUID();
          const html = await Bun.file(join(clientDirectory, "index.html")).text();

          return new Response(html.replace("<app-root>", `<app-root ngCspNonce="${nonce}">`), {
            headers: {
              ...headers,
              "Content-Type": "text/html;charset=utf-8",
              "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
            },
          });
        }

        const project = await session(decodeURIComponent(match[1]!.slice(0, -1)) || "/");
        if (stopping) return json({ error: "Server is stopping" }, 503);
        const action = match[2];
        if (request.method === "GET") return action === "api/state" ? json(project.snapshot()) : json({ error: "Not found" }, 404);
        if (project.busy && action !== "api/stop") return json({ error: "Validation is busy" }, 409);
        const body = await request.json();
        if (stopping) return json({ error: "Server is stopping" }, 503);

        // The core acquires its per-project busy flag synchronously.
        switch (action) {
          case "api/stop": await project.stop(); return json(project.snapshot());
          case "api/plan": await project.configure(body); return json(project.snapshot());
          case "api/detect": await project.detect(); return json(project.snapshot());
          case "api/run": {
            if (!["agent", "user"].includes(body?.caller)) throw new Error("Caller must be agent or user");
            if (body.caller === "agent") return json(await project.runForAgent());
            const run = await project.run("user");
            return json({ id: run.id });
          }
          default: return json({ error: "Not found" }, 404);
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        const status = code === "ENOENT" || code === "ENOTDIR" ? 404 : String(error).includes("Validation is busy") ? 409 : 400;

        return json({ error: String(error) }, status);
      }
    },
  });
}

if (import.meta.main) {
  try {
    const port = Number(process.env.PORT ?? 3210);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
    const cwd = resolve(process.argv[2] ?? process.cwd());
    const server = await startServer(cwd, port, {
      restart: () => relaunchServer(cwd, port),
    });

    console.log(`Validation UI: ${server.url}`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
