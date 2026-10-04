import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Validation, loadSteps } from "./server/core.ts";
import { runStryker, strykerTarget } from "./server/stryker.ts";
import mutation from "./server/steps/stryker-mutation.ts";

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "stryker-step-test-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

async function install(cwd: string) {
  const directory = join(cwd, "node_modules/@stryker-mutator/core");
  await Bun.write(join(cwd, "package.json"), "{}");
  await Bun.write(join(directory, "package.json"), '{"name":"@stryker-mutator/core"}');
  await Bun.write(join(directory, "bin/stryker.js"), "");
}

const original = {
  testRunner: "command",
  commandRunner: { command: "project-specific-tests" },
  mutate: ["src/**/*.ts", "!src/**/*.spec.ts"],
  thresholds: { high: 95, low: 70, break: 90 },
  reporters: ["clear-text"],
};

test("Stryker step is automatically discovered with a bounded score parameter", async () => {
  expect((await loadSteps()).some(step => step.name === mutation.name)).toBe(true);
  expect(mutation.parameters.minMutationScore).toMatchObject({ default: 80, min: 0, max: 100 });
});

test("pre-check requires both project config and installed Stryker CLI", () => fixture(async cwd => {
  expect(await mutation.detect({ cwd, scripts: {} })).toBe(false);
  await Bun.write(join(cwd, "stryker.config.json"), JSON.stringify(original));
  expect(await mutation.detect({ cwd, scripts: {} })).toBe(false);
  await install(cwd);
  expect(await mutation.detect({ cwd, scripts: {} })).toBe(true);
  await rm(join(cwd, "stryker.config.json"));
  expect(await mutation.detect({ cwd, scripts: {} })).toBe(false);
}));

for (const name of ["stryker.config.json", "stryker.conf.json", "stryker.config.mjs", "stryker.config.cjs", ".stryker.conf.json"]) {
  test(`preserves ${name}, overriding only the native breaking threshold`, () => fixture(async cwd => {
    await install(cwd);
    const content = name.endsWith("json") ? JSON.stringify(original)
      : `${name.endsWith("cjs") ? "module.exports =" : "export default"} ${JSON.stringify(original)};`;
    const source = join(cwd, name);
    await Bun.write(source, content);
    let temporary = "";
    const code = await runStryker({ cwd, scripts: {}, config: { minMutationScore: 55 } }, async (context, command) => {
      expect(context.cwd).toBe(cwd);
      expect(command.slice(0, 3)).toEqual(["node", (await strykerTarget(cwd))!.cli, "run"]);
      temporary = command[3]!;
      const config = (await import(pathToFileURL(temporary).href)).default;
      expect(config).toEqual({ ...original, thresholds: { ...original.thresholds, break: 55 } });
      return 0;
    });
    expect(code).toBe(0);
    expect(await Bun.file(source).text()).toBe(content);
    expect(await Bun.file(temporary).exists()).toBe(false);
  }));
}

for (const [exitCode, status] of [[0, "passed"], [1, "failed"], [3, "failed"]] as const) {
  test(`native exit ${exitCode} produces ${status} without custom output`, () => fixture(async cwd => {
    await install(cwd);
    await Bun.write(join(cwd, "stryker.config.json"), JSON.stringify(original));
    const step = { ...mutation, run: (context: Parameters<typeof runStryker>[0]) => runStryker(context, async (execution, command) => {
      const config = (await import(pathToFileURL(command[3]!).href)).default;
      expect(config.thresholds.break).toBe(80);
      execution.output?.("stderr", "native Stryker output\n");
      return exitCode;
    }) };
    const validation = await Validation.create(cwd, { steps: [step], persist: false });
    const result = (await validation.run()).results[0]!;
    expect(result.status).toBe(status);
    expect(result.exitCode).toBe(exitCode);
    expect(result.output).toBe("native Stryker output\n");
  }));
}

test("temporary config is cleaned after runner errors", () => fixture(async cwd => {
  await install(cwd);
  await Bun.write(join(cwd, "stryker.config.json"), "{}");
  let temporary = "";
  await expect(runStryker({ cwd, scripts: {} }, async (_, command) => {
    temporary = command[3]!;
    throw new Error("runner failed");
  })).rejects.toThrow("runner failed");
  expect(await Bun.file(temporary).exists()).toBe(false);
}));

test("missing Stryker and invalid thresholds fail without invoking a command", () => fixture(async cwd => {
  const context = { cwd, scripts: {} };
  await expect(runStryker(context)).rejects.toThrow("Stryker requires");
  await install(cwd);
  await Bun.write(join(cwd, "stryker.config.json"), "{}");
  for (const minMutationScore of [-1, 101, NaN, "80"]) {
    await expect(runStryker({ ...context, config: { minMutationScore } })).rejects.toThrow("minMutationScore");
  }
}));
