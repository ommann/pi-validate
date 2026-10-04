import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand, type Context } from "./step.ts";

const configNames = ["", "."].flatMap(prefix =>
  ["conf", "config"].flatMap(suffix =>
    ["json", "js", "mjs", "cjs"].map(extension => `${prefix}stryker.${suffix}.${extension}`)));

export type StrykerTarget = { cli: string; configFile: string };

export async function strykerTarget(cwd: string): Promise<StrykerTarget | undefined> {
  let configFile: string | undefined;
  for (const name of configNames) {
    const candidate = join(cwd, name);
    if (await Bun.file(candidate).exists()) { configFile = candidate; break; }
  }
  if (!configFile) return;

  const require = createRequire(join(cwd, "package.json"));
  // Check the filesystem afresh: Bun caches failed require.resolve lookups across dependency installs.
  for (const directory of require.resolve.paths("@stryker-mutator/core") ?? []) {
    const cli = join(directory, "@stryker-mutator/core/bin/stryker.js");
    if (await Bun.file(cli).exists()) return { cli, configFile };
  }
}

export async function runStryker(context: Context, execute = runCommand): Promise<number> {
  const target = await strykerTarget(context.cwd);
  if (!target) throw new Error("Stryker requires an installed @stryker-mutator/core and a project configuration");
  const minimum = context.config?.minMutationScore ?? 80;
  if (typeof minimum !== "number" || !Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
    throw new Error("minMutationScore must be between 0 and 100");
  }
  const temporary = await mkdtemp(join(tmpdir(), "validate-stryker-"));
  try {
    const configFile = join(temporary, "stryker.config.mjs");
    const original = target.configFile.endsWith(".json")
      ? `JSON.parse(await readFile(${JSON.stringify(target.configFile)}, "utf8"))`
      : `(await import(${JSON.stringify(pathToFileURL(target.configFile).href)})).default`;
    await Bun.write(configFile, `
import { readFile } from "node:fs/promises";
const base = ${original};
if (!base || typeof base !== "object" || Array.isArray(base)) {
  throw new Error("Stryker configuration must export an object");
}
export default {
  ...base,
  thresholds: { high: 80, low: 60, ...base.thresholds, break: ${minimum} },
};
`);
    return await execute(context, ["node", target.cli, "run", configFile]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
