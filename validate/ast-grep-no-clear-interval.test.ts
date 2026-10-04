import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validation, agentReport, loadSteps } from "./server/core.ts";
import step from "./server/steps/ast-grep-no-clear-interval.ts";

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "clear-interval-test-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

test("clearInterval step is discovered automatically", async () => {
  expect((await loadSteps()).some(candidate => candidate.name === step.name)).toBe(true);
});

test("detects source files, not dependencies, declarations or unrelated files", () => fixture(async cwd => {
  expect(await step.detect({ cwd, scripts: {} })).toBe(false);
  await Bun.write(join(cwd, "node_modules/dependency/index.js"), "clearInterval(timer);");
  await Bun.write(join(cwd, "dist/index.js"), "clearInterval(timer);");
  await Bun.write(join(cwd, "types.d.ts"), "declare function clearInterval(id: number): void;");
  await Bun.write(join(cwd, "notes.txt"), "clearInterval(timer);");
  expect(await step.detect({ cwd, scripts: {} })).toBe(false);
  await Bun.write(join(cwd, "src/index.ts"), "const timer: number = 1;");
  expect(await step.detect({ cwd, scripts: {} })).toBe(true);
}));

test("reports actual calls across JS/TS variants with source positions", () => fixture(async cwd => {
  const extensions = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
  for (const extension of extensions) {
    await Bun.write(join(cwd, `src/example.${extension}`), "// comment\nclearInterval(timer);\n");
  }
  const validation = await Validation.create(cwd, { steps: [step], persist: false });
  const run = await validation.run();
  expect(run.results[0]!.status).toBe("failed");
  expect(run.results[0]!.exitCode).toBe(1);
  const report = agentReport(run);
  expect(report.exitCode).toBe(1);
  expect(report.failures[0]!.name).toBe("ast-grep-no-clear-interval");
  for (const extension of extensions) {
    expect(report.failures[0]!.output).toContain(`src/example.${extension}:2:1: clearInterval usage: clearInterval(timer)`);
  }
  expect(report.failures[0]!.output.trim().split("\n")).toHaveLength(8);
}));

test("ignores comments, strings, references, timeouts and excluded directories", () => fixture(async cwd => {
  await Bun.write(join(cwd, "index.ts"), [
    "// clearInterval(timer);",
    'const text = "clearInterval(timer)";',
    "const cancel = clearInterval;",
    "clearTimeout(timer);",
    "setTimeout(() => {}, 100);",
  ].join("\n"));
  await Bun.write(join(cwd, "node_modules/dependency/index.js"), "clearInterval(timer);");
  await Bun.write(join(cwd, "build/index.js"), "clearInterval(timer);");
  const validation = await Validation.create(cwd, { steps: [step], persist: false });
  const run = await validation.run();
  expect(run.results[0]!.status).toBe("passed");
  expect(run.results[0]!.exitCode).toBe(0);
  expect(run.results[0]!.output).toBe("");
  expect(agentReport(run)).toEqual({ exitCode: 0, failures: [] });
}));
