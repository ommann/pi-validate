import { runCommand, type Step } from "../step.ts";

export default {
  name: "lint",
  detect: ({ scripts }) => typeof scripts.lint === "string" && scripts.lint.trim() !== "",
  run: context => runCommand(context, [process.execPath, "run", "lint"]),
} satisfies Step;
