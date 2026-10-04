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

test("stop is a trusted project-scoped POST available while a run is busy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "validate-stop-http-"));
  await Bun.write(join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "echo started; sleep 30" } }));
  const server = await startServer(cwd, 0, { persist: false });
  const base = new URL(projectPath(cwd), server.url);
  const post = (action: string, body = {}) => fetch(new URL(`api/${action}`, base), {
    method: "POST", headers: { "Content-Type": "application/json", "X-Validate": "1" }, body: JSON.stringify(body),
  });
  let running: Promise<Response> | undefined;

  try {
    expect((await fetch(new URL("api/stop", base))).status).toBe(404);
    expect((await fetch(new URL("api/stop", base), { method: "POST" })).status).toBe(403);
    running = post("run", { caller: "agent" });
    let started = false;
    for (let i = 0; i < 200 && !started; i++) {
      const state = await (await fetch(new URL("api/state", base))).json();
      started = state.runs.at(-1)?.results.some((result: any) => result.output.includes("started"));
      if (!started) await Bun.sleep(5);
    }
    expect(started).toBe(true);

    const stopped = await post("stop");
    expect(stopped.status).toBe(200);
    const state = await stopped.json();
    expect(state.busy).toBe(false);
    expect(state.running).toBe(false);
    expect(state.runs.at(-1).cancelled).toBe(true);
    expect(state.runs.at(-1).results.find((result: any) => result.name === "lint").status).toBe("cancelled");
    expect(await (await running).json()).toEqual({ exitCode: 130, cancelled: true, failures: [] });
    expect((await post("stop")).status).toBe(200);
  } finally {
    await post("stop");
    await running;
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
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
    expect(page.url).toBe(projectUrl.href);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain('<title>Validate</title>');
    expect(html).toContain('<app-root ngCspNonce="');

    const nonce = html.match(/ngCspNonce="([^"]+)"/)![1];
    const csp = page.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).not.toContain("'unsafe-inline'");

    const scriptPath = html.match(/<script src="([^"]+)"/)![1];
    const stylePath = html.match(/<link rel="stylesheet" href="([^"]+)"/)![1];
    for (const [path, type] of [[scriptPath, "javascript"], [stylePath, "text/css"]]) {
      const asset = await fetch(new URL(path!, url));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("Content-Type")).toContain(type!);
    }

    const reloaded = await (await fetch(projectUrl)).text();
    expect(reloaded.match(/ngCspNonce="([^"]+)"/)![1]).not.toBe(nonce);
    expect((await fetch(new URL("/app.js", url))).status).toBe(404);
    expect((await fetch(new URL("/client/missing.js", url))).status).toBe(404);
    expect((await post("/api/detect", {}, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(new URL("api/detect", projectUrl), { method: "POST", body: "{}" })).status).toBe(403);
    expect((await post("/api/plan", { groups: [["lint"], ["test"]], policies: { lint: "user", test: "agent" } })).status).toBe(200);
    const detected = await (await post("/api/detect", {})).json();
    expect(detected.steps.filter((step: any) => ["lint", "test"].includes(step.name)).every((step: any) => step.detection.applicable)).toBe(true);
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
