import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validation, agentReport } from "./server/core.ts";
import { runCommand, type Step } from "./server/step.ts";

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "validate-cancellation-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

test("stop cancels parallel work, preserves completed output, and never starts later groups", () => fixture(async cwd => {
  const started = Promise.withResolvers<void>();
  let active = 0;
  let later = false;
  const wait = (name: string): Step => ({
    name, detect: () => true,
    run: async context => {
      context.output?.("stdout", `${name} started\n`);
      if (++active === 2) started.resolve();
      await new Promise<void>(resolve => {
        context.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return 0;
    },
  });
  const validation = await Validation.create(cwd, { persist: false, steps: [
    { name: "done", detect: () => true, run: async context => { context.output?.("stdout", "Done\n"); return 0; } },
    wait("one"), wait("two"),
    { name: "later", detect: () => true, run: async () => { later = true; return 0; } },
  ] });
  await validation.configure({ groups: [["done"], ["one", "two"], ["later"]], policies: {} });

  const running = validation.run();
  await started.promise;
  expect(validation.snapshot().running).toBe(true);
  const stopped = validation.stop();
  expect(validation.snapshot().stopping).toBe(true);
  await stopped;
  const run = await running;

  expect(run.results.map(result => result.status)).toEqual(["passed", "cancelled", "cancelled", "cancelled"]);
  expect(run.results[0]!.output).toBe("Done\n");
  expect(run.results[1]!.output).toBe("one started\n");
  expect(later).toBe(false);
  expect(run.cancelled).toBe(true);
  expect(agentReport(run)).toEqual({ exitCode: 130, cancelled: true, failures: [] });
  expect(validation.snapshot().running).toBe(false);
  expect(validation.busy).toBe(false);
  await validation.stop();
}));

test("stop during detection prevents all execution and allows another run", () => fixture(async cwd => {
  const detecting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let executions = 0;
  const validation = await Validation.create(cwd, { persist: false, steps: [{
    name: "wait", detect: async () => { detecting.resolve(); await release.promise; return true; },
    run: async () => { executions++; return 0; },
  }] });

  const running = validation.run();
  await detecting.promise;
  const stopped = validation.stop();
  expect(validation.busy).toBe(true);
  release.resolve();
  await stopped;
  expect((await running).results[0]!.status).toBe("cancelled");
  expect(executions).toBe(0);

  expect((await validation.run()).results[0]!.status).toBe("passed");
  expect(executions).toBe(1);
}));

test("command cancellation kills descendants even when they ignore SIGTERM", () => fixture(async cwd => {
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  let output = "";
  const child = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';
  const parent = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdout: "inherit", stderr: "inherit" }); setInterval(() => {}, 1000);`;
  const running = runCommand({
    cwd, scripts: {}, signal: controller.signal,
    output: (_stream, text) => { output += text; if (output.includes("ready")) ready.resolve(); },
  }, [process.execPath, "-e", parent]);
  const outcome = running.then(() => undefined, error => error);

  await ready.promise;
  controller.abort();
  expect((await outcome)?.name).toBe("AbortError");
  expect(output).toContain("ready");
}));

test("already cancelled commands do not spawn", () => fixture(async cwd => {
  await expect(runCommand({ cwd, scripts: {}, signal: AbortSignal.abort() }, [process.execPath, "-e", "throw new Error('must not run')"])).rejects.toThrow();
}));
