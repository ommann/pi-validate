import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { projectPath } from "../validate/server/routes.ts";
import type { AgentReport } from "../validate/server/core.ts";

export const serverUrl = "http://127.0.0.1:3210";
export const logFile = join(tmpdir(), `pi-validate-${process.getuid?.() ?? "user"}.log`);

async function available(base: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/health", base), { signal: AbortSignal.timeout(1000) });
  } catch { return false; }
  const health = await response.json().catch(() => null);
  if (!response.ok || health?.service !== "validate" || health?.version !== 1) {
    throw new Error(`A different or outdated service is listening at ${base}`);
  }
  return true;
}

export async function ensureServer(base = serverUrl, signal?: AbortSignal, bun = process.env.VALIDATE_BUN ?? "bun") {
  signal?.throwIfAborted();
  if (await available(base)) return;
  const url = new URL(base);
  if (url.hostname !== "127.0.0.1") throw new Error("Automatic startup requires 127.0.0.1");
  const entry = fileURLToPath(new URL("../validate/server/server.ts", import.meta.url));
  const log = openSync(logFile, "a", 0o600);
  let child;
  try {
    child = spawn(bun, [entry], {
      cwd: fileURLToPath(new URL("../validate/", import.meta.url)),
      env: { ...process.env, PORT: url.port || "80" },
      detached: true,
      stdio: ["ignore", log, log],
    });
  } finally { closeSync(log); }
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    signal?.throwIfAborted();
    if (spawnError) throw new Error(`Cannot start validation server: ${spawnError.message}. Set VALIDATE_BUN to the Bun executable.`);
    if (await available(base)) return;
    await delay(100, undefined, { signal });
  }
  throw new Error(`Validation server did not start. See ${logFile}`);
}

export async function runValidation(cwd: string, signal?: AbortSignal, base = serverUrl): Promise<{ report: AgentReport; url: string }> {
  await ensureServer(base, signal);
  const url = new URL(projectPath(cwd), base);
  const response = await fetch(new URL("api/run", url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Validate": "1" },
    body: JSON.stringify({ caller: "agent" }), signal,
  });
  const report = await response.json();
  if (!response.ok) throw new Error(report.error ?? `HTTP ${response.status}`);
  return { report, url: url.href };
}
