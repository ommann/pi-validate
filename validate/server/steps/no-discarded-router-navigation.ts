import { parse } from "@ast-grep/napi";
import { extname, join } from "node:path";
import { languages, sourceFiles } from "../source-files.ts";
import type { Context, Step } from "../step.ts";

async function* routerFiles(cwd: string) {
  for await (const file of sourceFiles(cwd)) {
    const source = await Bun.file(join(cwd, file)).text();
    const root = parse(languages[extname(file) as keyof typeof languages], source).root();
    const importsRouter = root.findAll({ rule: { kind: "import_statement" } })
      .some(node => /\bfrom\s*['"]@angular\/router['"]/.test(node.text()));
    if (importsRouter) yield { file, root };
  }
}

export default {
  name: "no-discarded-router-navigation",
  async detect({ cwd }: Context) {
    for await (const entry of routerFiles(cwd)) {
      if (entry) return true;
    }
    return false;
  },
  async run(context: Context) {
    let failed = false;
    for await (const { file, root } of routerFiles(context.cwd)) {
      const matches = root.findAll({
        rule: { pattern: "void $ROUTER.$METHOD($$$ARGS)" },
        constraints: { METHOD: { regex: "^(navigate|navigateByUrl)$" } },
      });
      for (const match of matches) {
        const { line, column } = match.range().start;
        context.output?.("stdout", `${file}:${line + 1}:${column + 1}: Handle the navigation promise rejection instead of discarding it with void.\n`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  },
} satisfies Step;
