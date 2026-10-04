import { coverageTargets, runCoverageTarget } from "../angular-coverage.ts";
import type { Step } from "../step.ts";

export default {
  name: "vitest-coverage",
  parameters: {
    minLineCoverage: { type: "number", label: "Minimum TypeScript line coverage (%)", default: 80, min: 0, max: 100, step: 1 },
  },
  async detect({ cwd }) {
    return (await coverageTargets(cwd)).length > 0;
  },
  async run(context) {
    let failed = 0;
    for (const target of await coverageTargets(context.cwd)) {
      const code = await runCoverageTarget(context, target);
      if (code !== 0) failed ||= code;
    }
    return failed;
  },
} satisfies Step;
