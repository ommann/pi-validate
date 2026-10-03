import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server/server.ts";
import { projectPath } from "./server/routes.ts";

test("project URLs isolate tabs, settings, and concurrent runs without implicit writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-projects-"));
  const a = join(root, "a space # % ü");
  const b = join(root, "b");
  await Bun.write(join(a, "package.json"), JSON.stringify({ scripts: { lint: "sleep 0.3; echo project-a" } }));
  await Bun.write(join(b, "package.json"), JSON.stringify({ scripts: { lint: "echo project-b" } }));
  const server = await startServer(root, 0);
  const endpoint = (cwd: string, action = "") => new URL(projectPath(cwd) + action, server.url);
  const post = (cwd: string, action: string, body: unknown) => fetch(endpoint(cwd, action), {
    method: "POST", headers: { "Content-Type": "application/json", "X-Validate": "1" }, body: JSON.stringify(body),
  });
  const state = async (cwd: string) => (await fetch(endpoint(cwd, "api/state"))).json();
  let running: Promise<Response> | undefined;
  try {
    expect((await fetch(endpoint(a))).status).toBe(200);
    expect((await state(a)).cwd).toBe(a);
    running = post(a, "api/run", { caller: "agent" });
    for (let i = 0; i < 100 && !(await state(a)).busy; i++) await Bun.sleep(5);
    expect((await state(a)).busy).toBe(true);
    expect((await fetch(new URL('/api/shutdown', server.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Validate': '1' }, body: '{}',
    })).status).toBe(409);
    expect((await post(a, "api/run", { caller: "agent" })).status).toBe(409);
    const other = await post(b, "api/run", { caller: "agent" });
    expect(other.status).toBe(200);
    expect((await state(a)).busy).toBe(true);
    expect((await state(b)).runs[0].results.find((r: any) => r.name === "lint").output).toContain("project-b");
    expect((await running).status).toBe(200);
    expect((await state(a)).runs.length).toBe(1);
    expect(await Bun.file(join(a, ".validate.json")).exists()).toBe(false);
    expect(await Bun.file(join(b, ".validate.json")).exists()).toBe(false);
    expect((await post(a, "api/plan", { groups: [], policies: { lint: "off" } })).status).toBe(200);
    expect((await Bun.file(join(a, ".validate.json")).json()).policies.lint).toBe("off");
    expect((await state(b)).plan.policies.lint).toBe("agent");
  } finally {
    await running;
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown requires trusted POST and closes the server", async () => {
  const server = await startServer(process.cwd(), 0, { persist: false });
  const url = new URL('/api/shutdown', server.url);
  try {
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(url, { method: 'POST' })).status).toBe(403);
    const headers = { 'Content-Type': 'application/json', 'X-Validate': '1' };
    expect((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    const response = await fetch(url, { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    await Bun.sleep(200);
    await expect(fetch(new URL('/api/health', url))).rejects.toThrow();
  } finally { server.stop(true); }
});

test("HTTP UI keeps full logs while agent calls expose only promoted failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "validate-http-"));
  await Bun.write(join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "echo user-error >&2; exit 7", test: "echo happy-path" } }));
  const server = await startServer(cwd, 0, { persist: false });
  const url = server.url;
  const projectUrl = new URL(projectPath(cwd), url);
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(new URL(path.replace(/^\//, ''), projectUrl), {
    method: "POST", headers: { "Content-Type": "application/json", "X-Validate": "1", ...extra }, body: JSON.stringify(body),
  });
  try {
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Runs");
    expect(html).toContain('<button id="run" disabled>Run</button>');
    expect(html).not.toContain('id="status"');
    expect(html).not.toContain('id="run-agent"');
    expect(html).not.toContain('id="run-user"');
    expect(html).toContain('class="run-list"');
    expect(html).toContain('id="history-more"');
    expect(html).not.toContain('<select');
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect((await fetch(new URL("/app.js", url))).status).toBe(200);
    expect((await post("/api/detect", {}, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(new URL("api/detect", projectUrl), { method: "POST", body: "{}" })).status).toBe(403);
    expect((await post("/api/plan", { groups: [["lint"], ["test"]], policies: { lint: "user", test: "agent" } })).status).toBe(200);
    const detected = await (await post("/api/detect", {})).json();
    expect(detected.steps.filter((step: any) => !["build", "typescript-empty-lines"].includes(step.name)).every((step: any) => step.detection.applicable)).toBe(true);
    const report = await (await post("/api/run", { cwd, caller: "agent" })).json();
    expect(report).toEqual({ exitCode: 0, failures: [] });
    let state = await (await fetch(new URL("api/state", projectUrl))).json();
    expect(state.runs[0].results[0].output).toContain("user-error");
    expect(state.runs[0].results[1].output).toContain("happy-path");
    await post("/api/plan", { groups: [["lint", "test"]], policies: { lint: "agent", test: "agent" } });
    const promoted = await (await post("/api/run", { caller: "agent" })).json();
    expect(promoted.exitCode).toBe(7);
    expect(promoted.failures[0].output).toContain("user-error");
    // CLI goes through the same server and leaves another observable run.
    const cli = Bun.spawn([process.execPath, join(import.meta.dir, "server", "validate.ts"), cwd, "--server", url.toString()], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
    expect(code).toBe(7); expect(stdout).toBe(""); expect(stderr).toContain("user-error");
    state = await (await fetch(new URL("api/state", projectUrl))).json();
    expect(state.runs.length).toBe(3);
    expect(state.runs.every((run: any) => run.caller === "agent")).toBe(true);
    await post("/api/run", { caller: "user" });
    state = await (await fetch(new URL("api/state", projectUrl))).json();
    expect(state.runs.length).toBe(4);
    expect(state.runs[3].caller).toBe("user");
    expect(state.runs[0].results[0].output).toContain("user-error");
    expect((await post("/api/run", { caller: "invalid" })).status).toBe(400);
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});
