import { createRequire } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand, type Context } from "./step.ts";

const ignored = new Set([".git", ".hg", ".next", ".state", ".svn", "build", "coverage", "dist", "node_modules", "target", "vendor"]);
const configNames = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(extension => `vitest-base.config.${extension}`);

type TestOptions = { runner?: string; runnerConfig?: string | boolean };
type TestTarget = { builder?: string; options?: TestOptions; defaultConfiguration?: string; configurations?: Record<string, TestOptions> };
type AngularProject = { root?: string; architect?: Record<string, TestTarget>; targets?: Record<string, TestTarget> };
export type CoverageTarget = { cwd: string; project: string; cli: string; runnerConfig?: string };

// Only Angular's Vitest builder is supported. No inference from package script names.
export async function coverageTargets(cwd: string): Promise<CoverageTarget[]> {
  const targets: CoverageTarget[] = [];
  async function visit(directory: string) {
    const angularFile = Bun.file(join(directory, "angular.json"));
    if (await angularFile.exists()) {
      const workspace = await angularFile.json();
      const require = createRequire(join(directory, "package.json"));
      let cli: string;
      try {
        require.resolve("vitest/package.json");
        cli = require.resolve("@angular/cli/bin/ng.js");
        try { require.resolve("@vitest/coverage-v8"); }
        catch { require.resolve("@vitest/coverage-istanbul"); }
      } catch { return; }

      for (const [project, value] of Object.entries(workspace.projects ?? {})) {
        const definition = value as AngularProject;
        const target = (definition.architect ?? definition.targets)?.test;
        if (target?.builder !== "@angular/build:unit-test") continue;
        const options = { ...target.options, ...(target.defaultConfiguration ? target.configurations?.[target.defaultConfiguration] : {}) };
        if ((options.runner ?? "vitest") !== "vitest") continue;
        let runnerConfig: string | undefined;
        if (typeof options.runnerConfig === "string" && options.runnerConfig) {
          runnerConfig = resolve(directory, options.runnerConfig);
        } else if (options.runnerConfig === true) {
          for (const base of [resolve(directory, definition.root ?? ""), directory]) {
            for (const name of configNames) {
              const candidate = join(base, name);
              if (await Bun.file(candidate).exists()) { runnerConfig = candidate; break; }
            }
            if (runnerConfig) break;
          }
        }
        targets.push({ cwd: directory, project, cli, runnerConfig });
      }
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith(".validate-coverage-")) {
        await visit(join(directory, entry.name));
      }
    }
  }
  await visit(cwd);
  return targets;
}

export async function runCoverageTarget(context: Context, target: CoverageTarget, execute = runCommand): Promise<number> {
  const minimum = Number(context.config?.minLineCoverage ?? 80);
  const temporary = await mkdtemp(join(target.cwd, ".validate-coverage-"));
  const runnerConfig = join(temporary, "runner.mjs");
  const reportsDirectory = join(temporary, "reports");
  try {
    // Delegate config loading and instrumentation to the project's runner, retaining its setup/exclusions.
    await Bun.write(runnerConfig, `
export default async env => {
  const original = ${target.runnerConfig ? `(await import(${JSON.stringify(pathToFileURL(target.runnerConfig).href)})).default` : "{}"};
  const base = (typeof original === "function" ? await original(env) : await original) ?? {};
  return { ...base,
    plugins: [...(base.plugins ?? []), {
      name: "validate:coverage-threshold",
      // Apply after Angular merges workspace options, so its line threshold cannot override this parameter.
      enforce: "post",
      config: () => ({ test: { coverage: { thresholds: { lines: ${minimum}, autoUpdate: false } } } }),
    }],
    test: { ...base.test, coverage: {
    ...base.test?.coverage,
    enabled: true,
    include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    reportsDirectory: ${JSON.stringify(reportsDirectory)},
    reporter: ["text"],
  } } };
};
`);
    return await execute({ ...context, cwd: target.cwd }, [
      "node", target.cli, "test", target.project, "--watch=false", "--coverage",
      "--runner-config", runnerConfig, "--coverage-reporters", "text",
      "--coverage-include", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts",
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
