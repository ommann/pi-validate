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
