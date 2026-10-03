# Validate

Standalone Bun task orchestration service with a browser UI and CLI. The sibling `../pi-validate` package exposes it as a Pi tool and starts it automatically when needed.

```sh
nix develop --command bun server/server.ts /absolute/project/path
# Or, with Bun already available:
bun server/server.ts /absolute/project/path
```

The server listens on `127.0.0.1:3210` (`PORT` overrides it). `/` redirects to the initial project. Open any project directly:

```text
http://127.0.0.1:3210/projects/home/olli/Development/my-app/
```

URL-encode each path segment for spaces and special characters. Each browser tab stays on its own project. Opening another project in the folder form navigates only that tab. Projects are loaded on first access; no registration is required.

## API

Under `/projects/<absolute-path-without-leading-slash>/`:

- `GET api/state` — project, plan, detections, full run history/logs
- `POST api/detect` with `{}` — check step applicability
- `POST api/plan` with a plan — save configuration
- `POST api/run` with `{"caller":"agent"}` or `{"caller":"user"}` — run and await completion

POST requests require `Content-Type: application/json` and `X-Validate: 1`. Agent run responses contain only agent-visible failures and an exit code; user responses contain the run ID. Reads remain available during execution. Mutations on a busy project return 409; other projects are independent.

`GET /api/health` identifies the service. Global `/api/run`, `/api/state`, and project-selection endpoints are replaced by project-scoped routes.

## Settings

Settings live in the target project's `.validate.json`, formatted with two-space indentation. Absent file means defaults. Validation, detection, and opening a project do not write settings; saving a browser configuration does. Settings move with the project folder. Existing hash-keyed files in the runner's `.state/` are not migrated automatically; copy the appropriate JSON file to the target project's `.validate.json` if needed.

Logs and run history are in memory, not persisted.

## CLI

```sh
bun server/validate.ts /absolute/project/path
bun server/validate.ts /absolute/project/path --server http://127.0.0.1:3210
```

The first runs standalone; the second uses the shared server and appears in its UI.

## Tests

```sh
nix develop --command bun test . ../pi-validate
```
