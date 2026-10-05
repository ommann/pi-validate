import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validation } from "./server/core.ts";
import { startServer } from "./server/server.ts";
import { projectPath } from "./server/routes.ts";
import type { Step } from "./server/step.ts";

const step = (name: string, run: Step["run"]): Step => ({ name, detect: () => true, run });

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "validate-readiness-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

async function finished(validation: Validation) {
  while (validation.busy) await Bun.sleep(1);
}

test("agent response leaves user-facing steps running with full UI output and busy protection", () => fixture(async cwd => {
  const release = Promise.withResolvers<void>();
  const validation = await Validation.create(cwd, { persist: false, steps: [
    step("agent", async () => 0),
    step("user", async context => {
      context.output?.("stdout", "started\n");
      await release.promise;
      context.output?.("stdout", "user failure\n");
      return 7;
    }),
  ] });
  await validation.configure({ groups: [["agent", "user"]], policies: { agent: "agent", user: "user" } });
  let agentFinishedAt: string | undefined;
  try {
    expect(await validation.runForAgent()).toEqual({ exitCode: 0, failures: [] });
    expect(validation.snapshot().running).toBe(true);
    agentFinishedAt = validation.runs[0]!.agentFinishedAt;
    expect(agentFinishedAt).toBeDefined();
    expect(validation.runs[0]!.finishedAt).toBeUndefined();
    expect(validation.runs[0]!.results[1]!.status).toBe("running");
    await expect(validation.runForAgent()).rejects.toThrow("Validation is busy");
    await expect(validation.configure(validation.plan)).rejects.toThrow("Validation is busy");
  } finally { release.resolve(); await finished(validation); }
  expect(validation.runs[0]!.results[1]!.status).toBe("failed");
  expect(validation.runs[0]!.results[1]!.output).toBe("started\nuser failure\n");
  expect(validation.runs[0]!.finishedAt).toBeDefined();
  expect(validation.runs[0]!.agentFinishedAt).toBe(agentFinishedAt);
  expect(validation.snapshot().running).toBe(false);
}));

test("agent response includes every parallel agent failure and skips later agent checks without waiting for user steps", () => fixture(async cwd => {
  const userRelease = Promise.withResolvers<void>();
  const secondRelease = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const validation = await Validation.create(cwd, { persist: false, steps: [
    step("first", async () => 2),
    step("second", async () => { secondStarted.resolve(); await secondRelease.promise; return 3; }),
    step("user", async () => { await userRelease.promise; return 0; }),
    step("later", async () => { throw new Error("must not execute"); }),
  ] });
  await validation.configure({ groups: [["first", "second", "user"], ["later"]], policies: {
    first: "agent", second: "agent", user: "user", later: "agent",
  } });
  let responded = false;
  const report = validation.runForAgent().then(value => { responded = true; return value; });
  try {
    await secondStarted.promise;
    await Bun.sleep(0);
    expect(responded).toBe(false);
    secondRelease.resolve();
    expect((await report).failures.map(failure => failure.name)).toEqual(["first", "second"]);
    expect(validation.runs[0]!.results[3]!.status).toBe("skipped");
    expect(validation.busy).toBe(true);
  } finally { secondRelease.resolve(); userRelease.resolve(); await finished(validation); }
}));

test("section ordering is preserved when a later section still has agent checks", () => fixture(async cwd => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let agentRan = false;
  const validation = await Validation.create(cwd, { persist: false, steps: [
    step("user", async () => { started.resolve(); await release.promise; return 9; }),
    step("agent", async () => { agentRan = true; return 0; }),
  ] });
  await validation.configure({ groups: [["user"], ["agent"]], policies: { user: "user", agent: "agent" } });
  const report = validation.runForAgent();
  try {
    await started.promise;
    expect(agentRan).toBe(false);
    release.resolve();
    expect(await report).toEqual({ exitCode: 0, failures: [] });
    expect(agentRan).toBe(true);
  } finally { release.resolve(); await finished(validation); }
}));

test("no agent checks returns while user-facing analysis continues and remains cancellable", () => fixture(async cwd => {
  const validation = await Validation.create(cwd, { persist: false, steps: [
    step("user", async context => {
      await new Promise<void>(resolve => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return 0;
    }),
  ] });
  await validation.configure({ groups: [["user"]], policies: { user: "user" } });
  try {
    expect(await validation.runForAgent()).toEqual({ exitCode: 0, failures: [] });
    expect(validation.busy).toBe(true);
  } finally { await validation.stop(); }
  expect(validation.runs[0]!.results[0]!.status).toBe("cancelled");
  expect(validation.busy).toBe(false);
}));

test("user-initiated runs have no agent response timestamp", () => fixture(async cwd => {
  const validation = await Validation.create(cwd, { persist: false, steps: [step("check", async () => 0)] });
  const run = await validation.run("user");
  expect(run.finishedAt).toBeDefined();
  expect(run.agentFinishedAt).toBeUndefined();
}));

test("HTTP agent response finishes before user-facing analysis while state and stop remain available", () => fixture(async cwd => {
  await Bun.write(join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "echo user-started; sleep 30", test: "echo agent-done" } }));
  const server = await startServer(cwd, 0, { persist: false });
  const base = new URL(projectPath(cwd), server.url);
  const post = (action: string, body: unknown = {}) => fetch(new URL(`api/${action}`, base), {
    method: "POST", headers: { "Content-Type": "application/json", "X-Validate": "1" }, body: JSON.stringify(body),
  });
  try {
    expect((await post("plan", { groups: [["lint", "test"]], policies: { lint: "user", test: "agent" } })).status).toBe(200);
    const response = await post("run", { caller: "agent" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exitCode: 0, failures: [] });
    const state = await (await fetch(new URL("api/state", base))).json();
    expect(state.busy).toBe(true);
    expect(state.runs[0].results.find((result: any) => result.name === "lint").status).toBe("running");
    expect(state.runs[0].results.find((result: any) => result.name === "test").output).toContain("agent-done");
    expect((await post("run", { caller: "agent" })).status).toBe(409);
    const stopped = await (await post("stop")).json();
    expect(stopped.busy).toBe(false);
    expect(stopped.runs[0].results.find((result: any) => result.name === "lint").status).toBe("cancelled");
  } finally {
    await post("stop");
    server.stop(true);
  }
}));
