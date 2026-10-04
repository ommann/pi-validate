import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validation, loadSteps } from "./server/core.ts";
import type { Step } from "./server/step.ts";
import dynamicCode from "./server/steps/ast-grep-no-dynamic-code.ts";
import sanitizationBypass from "./server/steps/ast-grep-no-sanitization-bypass.ts";

async function fixture(operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "ast-security-test-"));
  try { await operation(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

const cases: { step: Step; forbidden: string[]; clean: string[] }[] = [
  {
    step: dynamicCode,
    forbidden: [
      "eval(code);", "Function(code);", "new Function('return 1');",
      "window.eval(code);", "globalThis.Function(code);", "new self.Function(code);",
      "global.eval(code);",
    ],
    clean: [
      "JSON.parse(text);", "object.eval(code);", "object.Function(code);",
      "const reference = eval;", "const name = 'eval(code)';", "// new Function(code);",
    ],
  },
  {
    step: sanitizationBypass,
    forbidden: [
      "sanitizer.bypassSecurityTrustHtml(input);",
      "this.sanitizer.bypassSecurityTrustStyle(input);",
      "inject(DomSanitizer).bypassSecurityTrustScript(input);",
      "sanitizer.bypassSecurityTrustUrl(input);",
      "sanitizer.bypassSecurityTrustResourceUrl(input);",
    ],
    clean: [
      "sanitizer.sanitize(context, input);", "const reference = sanitizer.bypassSecurityTrustHtml;",
      "const text = 'sanitizer.bypassSecurityTrustHtml(input)';",
      "// sanitizer.bypassSecurityTrustHtml(input);", "sanitizer.bypassSecurityTrustHtmlExtra(input);",
    ],
  },
];

for (const { step, forbidden, clean } of cases) {
  test(`${step.name}: automatically discovered`, async () => {
    expect((await loadSteps()).some(candidate => candidate.name === step.name)).toBe(true);
  });

  test(`${step.name}: matches fail with lint diagnostics`, () => fixture(async cwd => {
    await Bun.write(join(cwd, "source.ts"), forbidden.join("\n"));
    const validation = await Validation.create(cwd, { steps: [step], persist: false });
    const result = (await validation.run()).results[0]!;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    const lines = result.output.trim().split("\n");
    expect(lines).toHaveLength(forbidden.length);
    for (let index = 0; index < lines.length; index++) {
      expect(lines[index]).toStartWith(`source.ts:${index + 1}:1: error [${step.name}]: `);
    }
  }));

  test(`${step.name}: clean source passes silently; ignored paths stay ignored`, () => fixture(async cwd => {
    await Bun.write(join(cwd, "source.js"), clean.join("\n"));
    await Bun.write(join(cwd, "node_modules/dependency/index.js"), forbidden.join("\n"));
    await Bun.write(join(cwd, "dist/index.js"), forbidden.join("\n"));
    await Bun.write(join(cwd, "types.d.ts"), forbidden.join("\n"));
    const validation = await Validation.create(cwd, { steps: [step], persist: false });
    const result = (await validation.run()).results[0]!;
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
  }));

  test(`${step.name}: detects source presence rather than violations`, () => fixture(async cwd => {
    expect(await step.detect({ cwd, scripts: {} })).toBe(false);
    await Bun.write(join(cwd, "clean.tsx"), "const view = <div />;");
    expect(await step.detect({ cwd, scripts: {} })).toBe(true);
    expect(await step.run({ cwd, scripts: {} })).toBe(0);
  }));
}
