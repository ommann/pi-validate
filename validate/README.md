# Validate

Standalone Bun task orchestration service with an Angular browser UI and CLI. The sibling `../pi-validate` package exposes it as a Pi tool and starts it automatically when needed.

The frontend lives in `client/`; browser-safe helpers and API contracts live in `shared/`. Bun serves the built SPA. Install dependencies and build before starting the server:

```sh
bun install
bun install --cwd client
bun run build
```

```sh
nix develop --command bun server/server.ts /absolute/project/path
# Or, with Bun already available:
bun server/server.ts /absolute/project/path
```

The server listens on `127.0.0.1:3210` (`PORT` overrides it). `/` redirects to the initial project. Open any project directly:

```text
http://127.0.0.1:3210/home/olli/Development/my-app/
```

URL-encode each path segment for spaces and special characters. Each browser tab stays on its own project. Opening another project in the folder form navigates only that tab. Projects are loaded on first access; no registration is required.

## API

Under the URL-encoded absolute project path, e.g. `/home/olli/Development/my-app/`:

- `GET api/state` — project, plan, detections, full run history/logs
- `POST api/detect` with `{}` — check step applicability
- `POST api/plan` with a plan — save configuration
- `POST api/run` with `{"caller":"agent"}` or `{"caller":"user"}` — run and await completion

POST requests require `Content-Type: application/json` and `X-Validate: 1`. Agent run responses contain only agent-visible failures and an exit code; user responses contain the run ID. Reads remain available during execution. Mutations on a busy project return 409; other projects are independent.

`GET /api/health` identifies the service and its current instance. `POST /api/restart` relaunches Bun to load server changes; the UI waits for the new instance and reloads. Restart is refused while any project is busy. It clears in-memory run history, but preserves project settings. Old `/projects/.../` links redirect to the shorter URLs.

## Settings

Settings live in the target project's `.validate.json`, formatted with two-space indentation. Absent file means defaults. Validation, detection, and opening a project do not write settings; saving a browser configuration does. Settings move with the project folder. Existing hash-keyed files in the runner's `.state/` are not migrated automatically; copy the appropriate JSON file to the target project's `.validate.json` if needed.

Logs and run history are in memory, not persisted.

## AST checks

The automatically discovered `no-clear-timeout` step uses `@ast-grep/napi` directly
in Bun. It reports direct `clearTimeout(...)` calls with file, line, and column,
and fails when any are found. It covers JS, JSX, TS, TSX, and their module variants;
dependency/build directories and TypeScript declaration files are excluded.
No ast-grep executable or target-project Nix dependency is required.

Matching is syntactic: qualified calls such as `window.clearTimeout(...)` and
aliases are not detected, and locally defined `clearTimeout` functions also match.

## TypeScript test coverage

The `vitest-coverage` step discovers Angular workspaces (including nested `client/`
folders) with an `@angular/build:unit-test` Vitest target and an installed
`@vitest/coverage-v8` or `@vitest/coverage-istanbul` provider. It does not require a
particular package script name. Other test runners are not supported by this step.

`minLineCoverage` sets the minimum aggregate TypeScript line coverage percentage
(default 80, range 0–100), checked separately for each Angular project. The step
runs the project's Angular CLI with coverage, preserves existing runner setup and
exclusions, and includes TypeScript source files, including untested files.
Vitest natively enforces `minLineCoverage` as its line threshold; other project
coverage thresholds still apply. The step forwards native output and exit codes,
without parsing reports or adding its own coverage summary.

Coverage uses a temporary runner config and report directory, removed after execution;
project settings are not rewritten. The project's own provider performs all
instrumentation. This project's frontend includes `@vitest/coverage-v8`; its Bun
backend tests are not included in this step.

## Mutation testing (Stryker)

StrykerJS is installed in `validate/`. Its project-owned `stryker.config.json`
mutates frontend TypeScript only, excluding specs and declarations, and invokes
Angular's existing Vitest test target through the command runner. Bun backend
mutation testing is not configured.

From `validate/` (Node.js 22+ is required):

```sh
bun run mutation:dry                         # verify the instrumented baseline
bun run mutation --mutate client/src/app/server-control.ts  # smaller trial
bun run mutation                            # all configured frontend source
```

The native mutation-score failure threshold is `thresholds.break` (80%); `high`
and `low` control report colors. Results are native Stryker output plus an HTML
report at `reports/mutation/mutation.html`. Sandboxes live in `.state/stryker`,
which the validation source scanners already exclude.

The mutation command sets `NG_BUILD_TYPE_CHECK=0` for Angular 22: Stryker's
instrumentation changes inferred types and otherwise breaks Angular template
checking even before mutants are activated. This affects mutation runs only;
normal tests/builds retain type checking. The built-in Angular ignorer also
preserves compiler-required static metadata.

`coverageAnalysis: "off"` is required for the command runner: it cannot select
individual tests by mutant coverage. Each mutant reruns Angular build/tests, so
full runs are substantially slower than ordinary coverage. A dry run validates
the integration but does not measure mutation score.

## CLI

```sh
bun server/validate.ts /absolute/project/path
bun server/validate.ts /absolute/project/path --server http://127.0.0.1:3210
```

The first runs standalone; the second uses the shared server and appears in its UI.

## Tests

```sh
nix develop --command bun run test
```
