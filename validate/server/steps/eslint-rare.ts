import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { join } from "node:path";
import { sourceFiles } from "../source-files.ts";
import type { Step } from "../step.ts";

export default {
  name: "eslint-rare",
  async detect({ cwd }) {
    for await (const file of sourceFiles(cwd)) {
      if (file) return true;
    }
    return false;
  },
  async run(context) {
    const eslint = new ESLint({
      cwd: context.cwd,
      overrideConfigFile: true,
      ignore: false,
      overrideConfig: {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
          "array-callback-return": "error",
          "no-constructor-return": "error",
          "no-promise-executor-return": "error",
          "no-template-curly-in-string": "error",
          "no-unmodified-loop-condition": "error",
        },
      },
    });
    let failed = false;
    for await (const file of sourceFiles(context.cwd)) {
      const source = await Bun.file(join(context.cwd, file)).text();
      const results = await eslint.lintText(source, { filePath: join(context.cwd, file) });
      for (const result of results) {
        for (const message of result.messages) {
          const rule = message.ruleId ?? "parse-error";
          context.output?.("stdout", `${file}:${message.line ?? 1}:${message.column ?? 1}: error [${rule}]: ${message.message}\n`);
        }
        if (result.errorCount > 0) failed = true;
      }
    }
    return failed ? 1 : 0;
  },
} satisfies Step;
