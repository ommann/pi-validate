import { expect, test } from "bun:test";
import { Validation, loadSteps } from "./server/core.ts";
import step from "./server/steps/never-applicable.ts";

test("never-applicable is discovered and always skipped", async () => {
  expect((await loadSteps()).some(candidate => candidate.name === step.name)).toBe(true);
  const validation = await Validation.create(import.meta.dir, { steps: [step], persist: false });
  await validation.detect();
  expect(validation.detections[step.name]!.applicable).toBe(false);
  const result = (await validation.run()).results[0]!;
  expect(result.status).toBe("skipped");
  expect(result.reason).toBe("Not applicable");
  expect(result.exitCode).toBeUndefined();
  expect(result.output).toBe("");
});
