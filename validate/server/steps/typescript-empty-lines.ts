import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Context, Step } from "../step.ts";

const ignoredDirectories = new Set([
  ".git", ".hg", ".next", ".state", ".svn", "build", "coverage", "dist", "node_modules", "target", "vendor",
]);
const defaultMinEmptyLineRatio = 0.05;

type Counts = { files: number; source: number; empty: number };

function isTypeScriptFile(name: string) {
  return [".ts", ".tsx", ".mts", ".cts"].includes(extname(name)) && !name.endsWith(".d.ts");
}

async function countTypeScript(cwd: string): Promise<Counts> {
  const counts = { files: 0, source: 0, empty: 0 };

  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !isTypeScriptFile(entry.name)) continue;

      const text = await readFile(join(directory, entry.name), "utf8");
      const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
      if (lines.at(-1) === "") lines.pop();
      counts.files += 1;
      counts.source += lines.filter(line => line.trim() !== "").length;
      counts.empty += lines.filter(line => line.trim() === "").length;
    }
  }

  await visit(cwd);
  return counts;
}

export default {
  name: "typescript-empty-lines",
  parameters: {
    minEmptyLineRatio: { type: "number", label: "Minimum empty line ratio", default: defaultMinEmptyLineRatio, min: 0, max: 1, step: 0.01 },
  },
  async detect(context: Context) {
    return (await countTypeScript(context.cwd)).files > 0;
  },
  async run(context: Context) {
    const counts = await countTypeScript(context.cwd);
    const total = counts.source + counts.empty;
    const ratio = total === 0 ? 0 : counts.empty / total;
    const minEmptyLineRatio = Number(context.config?.minEmptyLineRatio ?? defaultMinEmptyLineRatio);
    const passed = ratio >= minEmptyLineRatio;
    context.output?.("stdout", [
      `TypeScript files: ${counts.files}`,
      `Source lines: ${counts.source}`,
      `Empty lines: ${counts.empty}`,
      `Empty line ratio: ${(ratio * 100).toFixed(1)}%`,
      `Conclusion: ${passed ? "OK" : "Too dense"} (${(ratio * 100).toFixed(1)}% ${passed ? ">=" : "<"} ${(minEmptyLineRatio * 100).toFixed(1)}%)`,
      "",
    ].join("\n"));
    return passed ? 0 : 1;
  },
} satisfies Step;
