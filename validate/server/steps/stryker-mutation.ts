import { runStryker, strykerTarget } from "../stryker.ts";
import type { Step } from "../step.ts";

export default {
  name: "stryker-mutation",
  parameters: {
    minMutationScore: { type: "number", label: "Minimum mutation score (%)", default: 80, min: 0, max: 100, step: 1 },
  },
  async detect({ cwd }) {
    return !!await strykerTarget(cwd);
  },
  run: context => runStryker(context),
} satisfies Step;
