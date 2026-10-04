import { astStep } from "../ast-step.ts";

export default astStep(
  "ast-grep-no-dynamic-code",
  "Do not execute strings as code with eval or Function.",
  {
    rule: {
      any: [
        { pattern: "eval($$$ARGS)" },
        { pattern: "Function($$$ARGS)" },
        { pattern: "new Function($$$ARGS)" },
        { pattern: "$GLOBAL.eval($$$ARGS)" },
        { pattern: "$GLOBAL.Function($$$ARGS)" },
        { pattern: "new $GLOBAL.Function($$$ARGS)" },
      ],
    },
    constraints: { GLOBAL: { regex: "^(window|globalThis|self|global)$" } },
  },
);
