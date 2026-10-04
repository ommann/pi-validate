import { astStep } from "../ast-step.ts";

export default astStep(
  "ast-grep-no-sanitization-bypass",
  "Do not bypass Angular sanitization; pass untrusted values through normal template bindings.",
  {
    rule: { pattern: "$RECEIVER.$METHOD($$$ARGS)" },
    constraints: {
      METHOD: { regex: "^bypassSecurityTrust(Html|Style|Script|Url|ResourceUrl)$" },
    },
  },
);
