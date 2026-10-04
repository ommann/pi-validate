import { test, expect } from "bun:test";
import { mkdtemp, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureServer, reportText, runValidation } from "./client.ts";
import { startServer } from "../validate/server/server.ts";

test("report text never calls cancelled or nonzero runs passed", () => {
  expect(reportText({ exitCode: 0, failures: [] })).toBe("Validation passed");
  expect(reportText({ exitCode: 130, cancelled: true, failures: [] })).toBe("Validation cancelled");
  expect(reportText({ exitCode: 130, failures: [] })).toBe("Validation cancelled");
  expect(reportText({ exitCode: 1, failures: [] })).toBe("Validation did not complete (exit 1)");
  const failures = [{ name: "lint", exitCode: 7, output: "bad" }];
  expect(reportText({ exitCode: 7, failures })).toBe("Failed: lint (exit 7)\nbad");
  expect(reportText({ exitCode: 130, cancelled: true, failures })).toBe("Validation cancelled\nFailed: lint (exit 7)\nbad");
});

test("client reconnects and returns only agent-visible failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-validate-client-"));
  const server = await startServer(cwd, 0);
  try {
    await Bun.write(join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "echo failure; exit 7" } }));
    const base = server.url.toString();
    await ensureServer(base, undefined, "must-not-launch");
    const { report, url } = await runValidation(cwd, undefined, base);
    expect(report.exitCode).toBe(7);
    expect(report.failures[0]!.output).toContain("failure");
    expect((await fetch(url)).status).toBe(200);
    expect(await Bun.file(join(cwd, ".validate.json")).exists()).toBe(false);
  } finally { server.stop(true); await rm(cwd, { recursive: true, force: true }); }
});

test("Node client starts a detached Bun service that survives its launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-validate-start-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const base = reservation.url.toString();
  reservation.stop(true);
  const pidFile = join(root, "pid");
  const wrapper = join(root, "bun-wrapper");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await Bun.write(wrapper, `#!/bin/sh\necho $$ > ${quote(pidFile)}\nexec ${quote(process.execPath)} "$@"\n`);
  await chmod(wrapper, 0o700);
  try {
    const module = pathToFileURL(join(import.meta.dir, "client.ts")).href;
    const launcher = Bun.spawn(["node", "--input-type=module", "-e", `import { ensureServer } from ${JSON.stringify(module)}; await ensureServer(${JSON.stringify(base)}, undefined, ${JSON.stringify(wrapper)});`], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(launcher.stderr).text();
    expect(await launcher.exited, stderr).toBe(0);
    expect((await (await fetch(new URL("api/health", base))).json()).service).toBe("validate");
    await ensureServer(base, undefined, "must-not-launch");
  } finally {
    const pid = await readFile(pidFile, "utf8").catch(() => "");
    if (pid) { try { process.kill(Number(pid), "SIGTERM"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
