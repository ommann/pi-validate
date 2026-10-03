import { resolve } from "node:path";
import { Validation, agentReport } from "./core.ts";
import { projectPath } from "./routes.ts";

// The core is independent of CLI, web UI, Pi, and MCP.
export async function validate(cwd: string): Promise<number> {
  const validation = await Validation.create(cwd);
  const report = agentReport(await validation.run("agent"));
  for (const failure of report.failures) {
    process.stderr.write(`Failed: ${failure.name}\n${failure.output}`);
  }
  return report.exitCode;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const serverIndex = args.indexOf("--server");
    let server: string | undefined;
    if (serverIndex !== -1) {
      server = args[serverIndex + 1];
      if (!server) throw new Error("--server requires a URL");
      args.splice(serverIndex, 2);
    }
    if (args.length > 1) throw new Error("Usage: bun server/validate.ts [project] [--server http://127.0.0.1:3210]");
    const cwd = resolve(args[0] ?? process.cwd());
    if (server) {
      const response = await fetch(new URL(projectPath(cwd) + "api/run", server), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Validate": "1" },
        body: JSON.stringify({ caller: "agent" }),
      });
      const report = await response.json();
      if (!response.ok) throw new Error(report.error ?? `HTTP ${response.status}`);
      for (const failure of report.failures) process.stderr.write(`Failed: ${failure.name}\n${failure.output}`);
      process.exitCode = report.exitCode;
    } else {
      process.exitCode = await validate(cwd);
    }
    if (process.exitCode === 0) console.log("Validate done");
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
