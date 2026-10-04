import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validation, loadSteps } from "./server/core.ts";
import step from "./server/steps/no-subscribe.ts";

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "no-subscribe-test-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

test("no-subscribe is discovered automatically", async () => {
  expect((await loadSteps()).some(candidate => candidate.name === step.name)).toBe(true);
});

test("subscribe method calls fail with locations", () => fixture(async cwd => {
  await Bun.write(join(cwd, "source.ts"), "stream.subscribe();\ninterval(500).subscribe(() => poll());\n");
  const validation = await Validation.create(cwd, { steps: [step], persist: false });
  const result = (await validation.run()).results[0]!;
  expect(result.status).toBe("failed");
  expect(result.exitCode).toBe(1);
  expect(result.output).toBe([
    "source.ts:1:1: subscribe() usage is forbidden.",
    "source.ts:2:1: subscribe() usage is forbidden.",
    "",
  ].join("\n"));
}));

test("comments, strings, references and other calls pass silently", () => fixture(async cwd => {
  await Bun.write(join(cwd, "source.js"), [
    "// stream.subscribe();",
    'const text = "stream.subscribe()";',
    "const method = stream.subscribe;",
    "stream.unsubscribe();",
    "subscribe();",
  ].join("\n"));
  await Bun.write(join(cwd, "node_modules/package/index.js"), "stream.subscribe();");
  const validation = await Validation.create(cwd, { steps: [step], persist: false });
  const result = (await validation.run()).results[0]!;
  expect(result.status).toBe("passed");
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("");
}));

test("detect is false without source files", () => fixture(async cwd => {
  expect(await step.detect({ cwd, scripts: {} })).toBe(false);
}));
