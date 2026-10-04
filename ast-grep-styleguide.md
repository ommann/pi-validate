# ast-grep check style guide

## Step format

Put checks in `validate/server/steps/<name>.ts`. Each file must default-export an object satisfying `Step` from `../step.ts`:

- `name`: a unique, descriptive identifier, such as `no-subscribe`.
- `detect(context)`: whether the check applies to the target project. Do not use violations as the applicability criterion: a clean project should pass, not be skipped.
- `run(context)`: return `0` when no violations exist, `1` when violations exist.

The runner discovers these files automatically, captures their output, and records their status and exit code. Checks are lint rules, not inventories.

## Use the SDK

Use `@ast-grep/napi` directly in Bun. Do not spawn the ast-grep CLI or require the target project to supply an executable.

Parse source using its language, then search the syntax tree:

```ts
const root = parse(language, source).root();
const matches = root.findAll("$RECEIVER.subscribe($$$ARGS)");
```

Use AST rules for code matching, not text searches. Comments and strings containing code must not count as calls.

Matching is syntactic, not TypeScript symbol resolution. A rule matching `.subscribe()` catches that method name on any receiver, not only RxJS observables. Keep each rule's scope explicit; do not claim it proves more than it checks.

## Analysis paths

Use `languages` and `sourceFiles()` from `validate/server/source-files.ts`.

- Scan recursively from `context.cwd`, the target project's directory.
- Support JS, JSX, TS, TSX, and their module extensions.
- Exclude dependency/build directories, declaration files, and symlinks.
- The current helper does not read `.gitignore`.

Apply additional scope restrictions only when the rule needs them, such as requiring an Angular router import.

## Diagnostic output

Emit one plain-text line per violation through `context.output`:

```text
src/app/validation.ts:58:18: error [no-subscribe]: subscribe() usage is forbidden.
```

Use this format:

```text
file:line:column: error [rule-name]: concise explanation
```

- Put the path first, without quotes or decoration.
- Use project-relative paths. Absolute paths are also valid when the consumer cannot resolve the target project's working directory.
- Lines and columns are **1-based**. SDK positions are 0-based, so add `1`.
- End each diagnostic with a newline.
- Include a stable rule identifier and a short explanation.
- Avoid ANSI colors, banners, source dumps, and call-count footers.
- Successful checks produce no output.

The `file:line:column` prefix is a common clickable-location format in IDEs and terminals. Relative-path resolution and link detection depend on the consumer; they are not guaranteed.

Example emission:

```ts
const { line, column } = match.range().start;
context.output?.(
  "stdout",
  `${file}:${line + 1}:${column + 1}: error [no-subscribe]: subscribe() usage is forbidden.\n`,
);
```

This is the preferred diagnostic format for new checks. Existing checks may still omit the severity and rule identifier.

## Tests

Test through the validation runner as well as the matcher:

- A real violation produces `status: "failed"` and `exitCode: 1`.
- Clean source produces `status: "passed"`, `exitCode: 0`, and empty output.
- Diagnostic paths, positions, and rule identifiers are correct.
- Comments, strings, and unrelated syntax do not trigger the rule.
- Ignored directories do not contribute violations.
- The step is automatically discovered.

Test any special call forms the rule claims to support, including chained receivers, optional calls, or computed properties. Do not assume one pattern covers all forms.
