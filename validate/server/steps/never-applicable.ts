import type { Step } from "../step.ts";

export default {
  name: "never-applicable",
  detect: () => false,
  run: async () => { throw new Error("never-applicable must not run"); },
} satisfies Step;
