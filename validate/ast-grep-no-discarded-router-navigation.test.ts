import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validation, loadSteps } from "./server/core.ts";
import step from "./server/steps/ast-grep-no-discarded-router-navigation.ts";

async function fixture(source: string, operation: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "router-navigation-test-"));
  try {
    await Bun.write(join(cwd, "page.ts"), source);
    await operation(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

const routerImport = "import { Router } from '@angular/router';\n";

test("navigation step is discovered automatically", async () => {
  expect((await loadSteps()).some(candidate => candidate.name === step.name)).toBe(true);
});

test("discarded navigation fails with file positions and no footer", () => fixture(
  routerImport + "void this.router.navigateByUrl('/project');\nvoid router.navigate(['/project']);\n",
  async cwd => {
    expect(await step.detect({ cwd, scripts: {} })).toBe(true);
    const validation = await Validation.create(cwd, { steps: [step], persist: false });
    const result = (await validation.run()).results[0]!;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe([
      "page.ts:2:1: Handle the navigation promise rejection instead of discarding it with void.",
      "page.ts:3:1: Handle the navigation promise rejection instead of discarding it with void.",
      "",
    ].join("\n"));
  },
));

test("caught, awaited and returned navigation is not flagged", () => fixture(routerImport + `
void router.navigateByUrl('/project').catch(reportError);
void router.navigate(['/project']).then(onSuccess, reportError);
async function open() { await router.navigateByUrl('/project'); }
function navigate() { return router.navigate(['/project']); }
// void router.navigateByUrl('/project');
const text = "void router.navigateByUrl('/project')";
`, async cwd => {
  const validation = await Validation.create(cwd, { steps: [step], persist: false });
  const result = (await validation.run()).results[0]!;
  expect(result.status).toBe("passed");
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("");
}));

test("does not apply to non-Angular sources or dependency files", () => fixture(
  "void router.navigateByUrl('/project');",
  async cwd => {
    await Bun.write(join(cwd, "node_modules/package/page.ts"), routerImport + "void router.navigate(['/']);");
    expect(await step.detect({ cwd, scripts: {} })).toBe(false);
    expect(await step.run({ cwd, scripts: {} })).toBe(0);
  },
));
