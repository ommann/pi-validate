import { parse } from "@ast-grep/napi";
import { extname, join } from "node:path";
import type { Context, Step } from "../step.ts";

import { languages, sourceFiles } from "../source-files.ts";

export default {
  name: "ast-grep-no-clear-interval",
  async detect({ cwd }: Context) {
    for await (const file of sourceFiles(cwd)) {
      if (file) return true;
    }
    return false;
  },
  async run(context: Context) {
    let count = 0;
    for await (const file of sourceFiles(context.cwd)) {
      const language = languages[extname(file) as keyof typeof languages];
      const source = await Bun.file(join(context.cwd, file)).text();
      const matches = parse(language, source).root().findAll("clearInterval($$$ARGS)");
      for (const match of matches) {
        const { line, column } = match.range().start;
        context.output?.("stdout", `${file}:${line + 1}:${column + 1}: clearInterval usage: ${match.text()}\n`);
        count++;
      }
    }
    return count > 0 ? 1 : 0;
  },
} satisfies Step;
