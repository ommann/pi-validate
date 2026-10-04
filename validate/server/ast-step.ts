import { parse, type NapiConfig } from "@ast-grep/napi";
import { extname, join } from "node:path";
import { languages, sourceFiles } from "./source-files.ts";
import type { Step } from "./step.ts";

export function astStep(name: string, message: string, matcher: NapiConfig): Step {
  return {
    name,
    async detect({ cwd }) {
      for await (const file of sourceFiles(cwd)) {
        if (file) return true;
      }
      return false;
    },
    async run(context) {
      let failed = false;
      for await (const file of sourceFiles(context.cwd)) {
        const source = await Bun.file(join(context.cwd, file)).text();
        const root = parse(languages[extname(file) as keyof typeof languages], source).root();
        for (const match of root.findAll(matcher)) {
          const { line, column } = match.range().start;
          context.output?.("stdout", `${file}:${line + 1}:${column + 1}: error [${name}]: ${message}\n`);
          failed = true;
        }
      }
      return failed ? 1 : 0;
    },
  };
}
