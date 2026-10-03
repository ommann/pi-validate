import { runCommand, type Step } from "../step.ts";

export default {
  name: "test",
  detect: ({ scripts }) => typeof scripts.test === "string" && scripts.test.trim() !== "",
  run: context => runCommand(context, [process.execPath, "run", "test"]),
} satisfies Step;
