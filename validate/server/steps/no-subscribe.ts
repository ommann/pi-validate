import { parse } from "@ast-grep/napi";
import { extname, join } from "node:path";
import { languages, sourceFiles } from "../source-files.ts";
import type { Context, Step } from "../step.ts";

export default {
  name: "no-subscribe",
  async detect({ cwd }: Context) {
    for await (const file of sourceFiles(cwd)) {
      if (file) return true;
    }
    return false;
  },
  async run(context: Context) {
    let failed = false;
    for await (const file of sourceFiles(context.cwd)) {
      const source = await Bun.file(join(context.cwd, file)).text();
      const root = parse(languages[extname(file) as keyof typeof languages], source).root();
      for (const match of root.findAll("$RECEIVER.subscribe($$$ARGS)")) {
        const { line, column } = match.range().start;
        context.output?.("stdout", `${file}:${line + 1}:${column + 1}: subscribe() usage is forbidden.\n`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  },
} satisfies Step;
