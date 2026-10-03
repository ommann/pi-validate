import { runCommand, type Step } from "../step.ts";

export default {
  name: "build",
  detect: ({ scripts }) => typeof scripts.build === "string" && scripts.build.trim() !== "",
  run: context => runCommand(context, [process.execPath, "run", "build"]),
} satisfies Step;
