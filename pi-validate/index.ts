import { Type } from "typebox";
import { truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runValidation } from "./client.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "validate",
    label: "Validate",
    description: "Run the current project's configured validation plan. Starts the local Bun service if needed. Returns agent-visible failures only; full logs are in the project web UI. Output is limited to 2000 lines or 50KB. Aborting stops waiting, not the server's run.",
    promptSnippet: "Run the project's validation plan through its local service",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const { report, url } = await runValidation(ctx.cwd, signal);
      const text = report.failures.length
        ? report.failures.map(failure => `Failed: ${failure.name} (exit ${failure.exitCode})\n${failure.output}`).join("\n")
        : "Validation passed";
      const output = truncateTail(text);
      return {
        content: [{ type: "text", text: `${output.content}${output.truncated ? "\n[Output truncated; full logs in web UI.]" : ""}` }],
        details: { exitCode: report.exitCode, url },
      };
    },
  });
}
