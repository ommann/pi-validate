import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validation, agentReport, checkPlan } from "./server/core.ts";
import { runCommand, executionCommand, type Step } from "./server/step.ts";

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "validate-test-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

const fake = (name: string, code = 0): Step => ({
  name, detect: () => true,
  run: async context => { context.output?.("stdout", `${name} full output\n`); return code; },
});

test("project settings default without a file, persist as JSON, and move with the folder", () => fixture(async root => {
  const cwd = join(root, "project");
  await mkdir(cwd);
  const steps = [fake("lint"), fake("test"), fake("build")];
  const configFile = join(cwd, ".validate.json");
  const validation = await Validation.create(cwd, { steps });
  expect(validation.plan).toEqual(checkPlan({ groups: [], policies: {} }, steps));
  expect(await Bun.file(configFile).exists()).toBe(false);

  await validation.configure({
    groups: [["lint", "test"]],
    policies: { lint: "agent", test: "user", build: "off" },
    removed: ["build"],
    useNix: true,
  });
  expect(await Bun.file(configFile).text()).toBe(JSON.stringify(validation.plan, null, 2) + "\n");
  expect(await Bun.file(configFile + ".tmp").exists()).toBe(false);
  expect((await Validation.create(cwd, { steps })).plan).toEqual(validation.plan);

  const moved = join(root, "renamed-project");
  await rename(cwd, moved);
  expect((await Validation.create(moved, { steps })).plan).toEqual(validation.plan);
}));

test("persist false neither reads nor changes project settings", () => fixture(async cwd => {
  const steps = [fake("lint")];
  const configFile = join(cwd, ".validate.json");
  const saved = JSON.stringify({ groups: [["lint"]], policies: { lint: "off" } });
  await Bun.write(configFile, saved);
  const validation = await Validation.create(cwd, { steps, persist: false });
  expect(validation.plan.policies.lint).toBe("agent");
  await validation.configure({ groups: [["lint"]], policies: { lint: "user" } });
  expect(await Bun.file(configFile).text()).toBe(saved);
}));

test("real modules detect package scripts and preserve happy-path output", () => fixture(async cwd => {
  await Bun.write(join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "echo lint-good", test: "echo test-good" } }));
  const validation = await Validation.create(cwd, { persist: false });
  await validation.detect();
  expect(validation.detections.lint!.applicable).toBe(true);
  const run = await validation.run();
  expect(run.results.find(result => result.name === "build")!.status).toBe("skipped");
  expect(run.results.find(result => result.name === "lint")!.status).toBe("passed");
  expect(run.results.find(result => result.name === "lint")!.output).toContain("lint-good");
  expect(run.results.find(result => result.name === "test")!.status).toBe("passed");
  expect(run.results.find(result => result.name === "test")!.output).toContain("test-good");
  expect(agentReport(run)).toEqual({ exitCode: 0, failures: [] });
}));

test("user-only failures stay in full results; promotion affects subsequent calls", () => fixture(async cwd => {
  const validation = await Validation.create(cwd, { steps: [fake("lint", 7), fake("test")], persist: false });
  await validation.configure({ groups: [["lint"], ["test"]], policies: { lint: "user", test: "agent" } });
  const first = await validation.run();
  expect(first.results.map(result => result.status)).toEqual(["failed", "passed"]);
  expect(first.results[0]!.output).toContain("lint full output");
  expect(agentReport(first)).toEqual({ exitCode: 0, failures: [] });
  await validation.configure({ groups: [["lint"], ["test"]], policies: { lint: "agent", test: "agent" } });
  const second = await validation.run();
  expect(second.results.map(result => result.status)).toEqual(["failed", "skipped"]);
  expect(agentReport(second).exitCode).toBe(7);
  expect(agentReport(second).failures[0]!.output).toContain("lint full output");
  expect(first.results[0]!.policy).toBe("user");
  const userRun = await validation.run("user");
  expect(userRun.results.map(result => result.status)).toEqual(["failed", "passed"]);
}));

test("disabled steps are detected independently but never run", () => fixture(async cwd => {
  let executions = 0;
  const step = fake("disabled");
  step.run = async () => { executions++; return 0; };
  const validation = await Validation.create(cwd, { steps: [step], persist: false });
  await validation.configure({ groups: [["disabled"]], policies: { disabled: "off" } });
  await validation.detect();
  expect(validation.detections.disabled!.applicable).toBe(true);
  expect((await validation.run()).results[0]!.status).toBe("skipped");
  expect(executions).toBe(0);
}));

test("parallel group waits for every member before stopping; busy operations rejected", () => fixture(async cwd => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let finished = false;
  const wait: Step = { name: "wait", detect: () => true, run: async () => { started.resolve(); await release.promise; finished = true; return 0; } };
  const validation = await Validation.create(cwd, { steps: [fake("fail", 9), wait, fake("later")], persist: false });
  await validation.configure({ groups: [["fail", "wait"], ["later"]], policies: {} });
  const running = validation.run();
  await started.promise;
  expect(validation.busy).toBe(true);
  expect(validation.runs[0]!.results[1]!.status).toBe("running");
  await expect(validation.detect()).rejects.toThrow("busy");
  await expect(validation.configure({})).rejects.toThrow("busy");
  release.resolve();
  const run = await running;
  expect(finished).toBe(true);
  expect(run.results.map(result => result.status)).toEqual(["failed", "passed", "skipped"]);
  expect(validation.busy).toBe(false);
}));

test("detection errors are failures; absent applicability is a skip", () => fixture(async cwd => {
  const validation = await Validation.create(cwd, { persist: false, steps: [
    { ...fake("broken"), detect: () => { throw new Error("detection failed"); } },
    { ...fake("absent"), detect: () => false },
  ] });
  const run = await validation.run("user");
  expect(run.results[0]!.status).toBe("failed");
  expect(run.results[0]!.output).toContain("detection failed");
  expect(run.results[1]!.status).toBe("skipped");
}));

test("plans reject mistakes and append newly discovered modules deterministically", () => {
  const steps = [fake("lint"), fake("test")];
  expect(checkPlan({ groups: [["test"]], policies: {} }, steps).groups).toEqual([["test"], ["lint"]]);
  expect(() => checkPlan({ groups: [["unknown"]], policies: {} }, steps)).toThrow("Unknown");
  expect(() => checkPlan({ groups: [["lint", "lint"]], policies: {} }, steps)).toThrow("Repeated");
  expect(() => checkPlan({ groups: [], policies: { lint: "bad" } }, steps)).toThrow("Invalid policy");
});

test("removed steps stay out of the plan while off steps remain visible", () => fixture(async cwd => {
  const validation = await Validation.create(cwd, { steps: [fake("lint"), fake("test")], persist: false });
  await validation.configure({ groups: [["lint"]], policies: { lint: "off", test: "agent" }, removed: ["test"] });
  expect(validation.plan.groups).toEqual([["lint"]]);
  const run = await validation.run();
  expect(run.results.map(result => result.name)).toEqual(["lint"]);
  expect(run.results[0]!.status).toBe("skipped");
}));

test("Nix execution prefix is configurable and passes through the central runner", () => fixture(async cwd => {
  const command = [process.execPath, "run", "build"];
  expect(executionCommand({ cwd, scripts: {} }, command)).toEqual(command);
  expect(executionCommand({ cwd, scripts: {}, useNix: true }, command)).toEqual(["nix", "develop", "--command", ...command]);
  let useNix: boolean | undefined;
  const step: Step = { name: "build", detect: () => true, run: async context => { useNix = context.useNix; return 0; } };
  const validation = await Validation.create(cwd, { steps: [step], persist: false });
  await validation.configure({ groups: [["build"]], policies: {}, useNix: true });
  const run = await validation.run();
  expect(useNix).toBe(true);
  expect(run.plan.useNix).toBe(true);
  expect(() => checkPlan({ groups: [], policies: {}, useNix: "yes" }, [step])).toThrow("boolean");
}));

test("command helper captures both streams and rejects missing executables", () => fixture(async cwd => {
  let output = "";
  const context = { cwd, scripts: {}, output: (_stream: string, text: string) => { output += text; } };
  expect(await runCommand(context, [process.execPath, "-e", 'console.log("stdout"); console.error("stderr"); process.exit(3)'])).toBe(3);
  expect(output).toContain("stdout"); expect(output).toContain("stderr");
  await expect(runCommand(context, ["nonexistent-validate-command-1234"])).rejects.toThrow("Executable not found");
}));
