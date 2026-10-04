import { Lang } from "@ast-grep/napi";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const ignoredDirectories = new Set([
  ".git", ".hg", ".next", ".state", ".svn", "build", "coverage", "dist", "node_modules", "target", "vendor",
]);
export const languages = {
  ".js": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
  ".ts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".mts": Lang.TypeScript,
  ".cts": Lang.TypeScript,
};

export async function* sourceFiles(cwd: string, directory = ""): AsyncGenerator<string> {
  for (const entry of await readdir(join(cwd, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) yield* sourceFiles(cwd, path);
    } else if (entry.isFile() && Object.hasOwn(languages, extname(entry.name)) && !/\.d\.(ts|mts|cts)$/.test(entry.name)) {
      yield path;
    }
  }
}
