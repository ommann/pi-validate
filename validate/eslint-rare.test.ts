import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validation, loadSteps } from "./server/core.ts";
import step from "./server/steps/eslint-rare.ts";

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "eslint-rare-test-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

test("eslint-rare is automatically discovered", async () => {
  expect((await loadSteps()).some(candidate => candidate.name === step.name)).toBe(true);
});

const violations = {
  "array-callback-return": "items.map(item => { process(item); });",
  "no-constructor-return": "class Thing { constructor() { return {}; } }",
  "no-promise-executor-return": "new Promise(resolve => resolve(42));",
  "no-template-curly-in-string": `const message = 'Hello \${name}';`,
  "no-unmodified-loop-condition": "let ready = true; while (ready) { process(); }",
};

for (const [rule, source] of Object.entries(violations)) {
  test(`eslint-rare catches ${rule}`, () => fixture(async cwd => {
    await Bun.write(join(cwd, "source.ts"), source);
    const validation = await Validation.create(cwd, { steps: [step], persist: false });
    const result = (await validation.run()).results[0]!;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(new RegExp(`^source\\.ts:1:\\d+: error \\[${rule}\\]: `));
    expect(result.output.trim().split("\n")).toHaveLength(1);
  }));
}

test("clean JS/TS variants pass silently without project config or scripts", () => fixture(async cwd => {
  const clean = [
    "const values = items.map(item => item.id);",
    "async function run() { for (const item of items) { await process(item); } }", 
    "class Thing { constructor() { this.id = 1; } }",
    "new Promise(resolve => { resolve(42); });",
    `const message = \`Hello \${name}\`;`,
    "let ready = true; while (ready) { ready = check(); }",
  ].join("\n");
  for (const extension of ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]) {
    await Bun.write(join(cwd, `source.${extension}`), clean);
  }
  await Bun.write(join(cwd, "typed.tsx"), "const count: number = 1; const view = <div>{count}</div>;");
  await Bun.write(join(cwd, "node_modules/dependency/index.js"), violations["array-callback-return"]);
  await Bun.write(join(cwd, "dist/index.js"), violations["array-callback-return"]);
  await Bun.write(join(cwd, "types.d.ts"), "not valid syntax @");
  const validation = await Validation.create(cwd, { steps: [step], persist: false });
  const result = (await validation.run()).results[0]!;
  expect(result.status).toBe("passed");
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("");
}));

test("project ESLint config cannot disable central rules", () => fixture(async cwd => {
  await Bun.write(join(cwd, "eslint.config.mjs"), "throw new Error('Project config must not load');");
  await Bun.write(join(cwd, "source.ts"), violations["array-callback-return"]);
  let output = "";
  expect(await step.run({ cwd, scripts: {}, output: (_stream, text) => { output += text; } })).toBe(1);
  expect(output).toContain("error [array-callback-return]");
  expect(output).not.toContain("Project config must not load");
}));

test("parse errors fail rather than silently passing", () => fixture(async cwd => {
  await Bun.write(join(cwd, "source.ts"), "const = ;");
  let output = "";
  expect(await step.run({ cwd, scripts: {}, output: (_stream, text) => { output += text; } })).toBe(1);
  expect(output).toContain("error [parse-error]");
}));

test("no source files means not applicable", () => fixture(async cwd => {
  expect(await step.detect({ cwd, scripts: {} })).toBe(false);
}));
