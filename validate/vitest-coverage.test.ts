import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { coverageTargets, runCoverageTarget, type CoverageTarget } from "./server/angular-coverage.ts";
import { Validation, loadSteps } from "./server/core.ts";
import coverage from "./server/steps/vitest-coverage.ts";

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "vitest-coverage-test-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

async function workspace(cwd: string, provider = true) {
  await Bun.write(join(cwd, "package.json"), "{}");
  await Bun.write(join(cwd, "angular.json"), JSON.stringify({ projects: {
    app: { architect: { test: { builder: "@angular/build:unit-test" } } },
  } }));
  for (const name of ["vitest", "@angular/cli", ...(provider ? ["@vitest/coverage-v8"] : [])]) {
    await Bun.write(join(cwd, "node_modules", name, "package.json"), JSON.stringify({ name, main: "index.js" }));
    await Bun.write(join(cwd, "node_modules", name, "index.js"), "export default {};");
  }
  await Bun.write(join(cwd, "node_modules/@angular/cli/bin/ng.js"), "");
}

test("coverage is discovered with bounded percentage parameter", async () => {
  expect((await loadSteps()).some(step => step.name === coverage.name)).toBe(true);
  expect(coverage.parameters.minLineCoverage).toMatchObject({ min: 0, max: 100, default: 80 });
});

test("pre-check requires Angular Vitest and an installed provider, including nested workspaces", () => fixture(async cwd => {
  const client = join(cwd, "frontend");
  await workspace(client, false);
  expect(await coverage.detect({ cwd, scripts: {} })).toBe(false);
  const ready = join(cwd, "ready");
  await workspace(ready);
  expect((await coverageTargets(cwd)).map(target => target.project)).toEqual(["app"]);
  await Bun.write(join(ready, "angular.json"), JSON.stringify({ projects: {
    app: { architect: { test: { builder: "@angular/build:unit-test", options: { runner: "karma" } } } },
  } }));
  expect(await coverage.detect({ cwd, scripts: {} })).toBe(false);
}));

test("dependency directories are not searched for test targets", () => fixture(async cwd => {
  await workspace(join(cwd, "node_modules/dependency"));
  expect(await coverage.detect({ cwd, scripts: {} })).toBe(false);
}));

for (const [minimum, exitCode, status] of [[80, 0, "passed"], [80, 1, "failed"], [50, 0, "passed"]] as const) {
  test(`native coverage threshold ${minimum}% with runner exit ${exitCode} is ${status}`, () => fixture(async cwd => {
    await workspace(cwd);
    const [target] = await coverageTargets(cwd);
    const step = { ...coverage, run: (context: Parameters<typeof runCoverageTarget>[0]) => runCoverageTarget(context, target!, async (execution, command) => {
      expect(execution.cwd).toBe(cwd);
      expect(command).toContain("--watch=false");
      expect(command).toContain("--coverage");
      const configPath = command[command.indexOf("--runner-config") + 1]!;
      const config = await (await import(pathToFileURL(configPath).href)).default({});
      expect(config.test.coverage.include).toEqual(["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]);
      const plugin = config.plugins.at(-1);
      expect(plugin.enforce).toBe("post");
      expect(plugin.config().test.coverage.thresholds).toEqual({ lines: minimum, autoUpdate: false });
      expect(config.test.coverage.reporter).toEqual(["text"]);
      execution.output?.("stderr", "native runner output\n");
      return exitCode;
    }) };
    const validation = await Validation.create(cwd, { steps: [step], persist: false });
    await validation.configure({ groups: [[step.name]], policies: {}, configs: { [step.name]: { minLineCoverage: minimum } } });
    const result = (await validation.run()).results[0]!;
    expect(result.status).toBe(status);
    expect(result.exitCode).toBe(exitCode);
    expect(result.output).toBe("native runner output\n");
    expect((await readdir(cwd)).some(name => name.startsWith(".validate-coverage-"))).toBe(false);
  }));
}

test("existing runner configuration is preserved, including async config functions", () => fixture(async cwd => {
  await workspace(cwd);
  await Bun.write(join(cwd, "original.mjs"), "export default async () => ({ test: { setupFiles: ['setup.ts'], coverage: { exclude: ['ignored.ts'] } } });");
  await Bun.write(join(cwd, "angular.json"), JSON.stringify({ projects: {
    app: { architect: { test: { builder: "@angular/build:unit-test", defaultConfiguration: "ci", configurations: { ci: { runnerConfig: "original.mjs" } } } } },
  } }));
  const [target] = await coverageTargets(cwd);
  expect(target!.runnerConfig).toBe(join(cwd, "original.mjs"));
  await runCoverageTarget({ cwd, scripts: {} }, target!, async (_, command) => {
    const configPath = command[command.indexOf("--runner-config") + 1]!;
    const config = await (await import(pathToFileURL(configPath).href)).default({});
    expect(config.test.setupFiles).toEqual(["setup.ts"]);
    expect(config.test.coverage.exclude).toEqual(["ignored.ts"]);
    return 2;
  });
}));

test("failed tests propagate their exit code and temporary configuration is cleaned", () => fixture(async cwd => {
  const target: CoverageTarget = { cwd, project: "app", cli: "unused" };
  expect(await runCoverageTarget({ cwd, scripts: {} }, target, async () => 3)).toBe(3);
  expect(await readdir(cwd)).toEqual([]);
}));

test("runner errors clean up temporary configuration", () => fixture(async cwd => {
  const target: CoverageTarget = { cwd, project: "app", cli: "unused" };
  await expect(runCoverageTarget({ cwd, scripts: {} }, target, async () => {
    throw new Error("runner failed");
  })).rejects.toThrow("runner failed");
  expect(await readdir(cwd)).toEqual([]);
}));
