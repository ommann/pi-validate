# pi-validate

A thin Pi extension for the sibling `../validate` Bun service. Both directories stay together in the pi-s-walker checkout.

## Use

Install this local package in Pi:

```sh
pi install /absolute/path/to/pi-s-walker/pi-validate
```

Reload Pi with `/reload`. The agent gets one tool: `validate`, with no arguments. It uses Pi's current project directory.

Bun must be on Pi's PATH, or set `VALIDATE_BUN` to its absolute executable path before launching Pi. Pi itself does not need to run under Bun.

On first invocation the tool checks `http://127.0.0.1:3210/api/health`, starts the sibling server if absent, and waits for it to become ready. Subsequent invocations reuse it. The server is detached with output in the OS temporary directory's `pi-validate-<uid>.log`; closing Pi or its terminal does not intentionally stop the server. Stop it manually when wanted. After server code changes, restart it to use the updated code.

The tool returns agent-visible failures and a project web URL. The browser shows full logs. Each project has its own plan, history, and busy flag; different projects can run concurrently. A second run on the same busy project is rejected. Aborting a Pi call stops waiting, not the server's work.

No settings file is created by invocation. Saving configuration through the browser writes `<project>/.validate.json`. Run history is in memory and disappears when the server stops.

## Tests

From `../validate`:

```sh
nix develop --command bun test . ../pi-validate
```
