import { test, expect } from "bun:test";
import { activeGroups, editPlan, dropStep } from "./shared/plan.js";

const plan = { groups: [["lint"], ["test"]], policies: { lint: "agent", test: "user", extra: "off" }, removed: ["extra"] };

test("dragging to rows joins groups; dragging to lines creates sequential groups", () => {
  expect(dropStep(plan, "lint", 1).groups).toEqual([["test", "lint"]]);
  expect(dropStep(plan, "test", 0, true).groups).toEqual([["test"], ["lint"]]);
  expect(dropStep(plan, "lint", 2, true).groups).toEqual([["test"], ["lint"]]);
  const joined = dropStep(plan, "test", 0);
  expect(dropStep(joined, "test", 1, true).groups).toEqual([["lint"], ["test"]]);
  expect(dropStep(plan, "unknown", 0)).toEqual(plan);
  expect(dropStep(plan, "lint", 99)).toEqual(plan);
  expect(plan.groups).toEqual([["lint"], ["test"]]);
});

test("dividers represent active groups; joining and separating preserve policy", () => {
  expect(activeGroups(plan)).toEqual([["lint"], ["test"]]);
  const joined = editPlan(plan, "test", "join");
  expect(joined.groups).toEqual([["lint", "test"]]);
  expect(joined.policies.test).toBe("user");
  expect(editPlan(joined, "test", "separate").groups).toEqual([["lint"], ["test"]]);
  expect(plan.groups).toEqual([["lint"], ["test"]]);
});

test("plan edits and dragging preserve Nix execution option", () => {
  const nixPlan = { ...plan, options: { useNix: true, runsFirst: true, newestRunsFirst: true } };
  expect(editPlan(nixPlan, "lint", "user").options).toEqual(nixPlan.options);
  expect(dropStep(nixPlan, "lint", 1).options).toEqual(nixPlan.options);
});

test("reorder groups, turn off, and add from catalog", () => {
  expect(editPlan(plan, "test", "up").groups).toEqual([["test"], ["lint"]]);
  expect(editPlan(plan, "lint", "down").groups).toEqual([["test"], ["lint"]]);
  const off = editPlan(plan, "lint", "off");
  expect(off.groups).toEqual([["lint"], ["test"]]);
  expect(off.policies.lint).toBe("off");
  const removed = editPlan(off, "lint", "remove");
  expect(removed.groups).toEqual([["test"]]);
  expect(removed.removed).toContain("lint");
  const added = editPlan(removed, "lint", "add");
  expect(added.groups).toEqual([["test"], ["lint"]]);
  expect(added.policies.lint).toBe("off");
  expect(added.removed).not.toContain("lint");
  expect(editPlan(plan, "extra", "add").groups).toEqual([["lint"], ["test"], ["extra"]]);
});
