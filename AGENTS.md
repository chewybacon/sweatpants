# Agent Instructions

## How we work

- Do not add or run unit tests. New features MAY have acceptance tests under `acceptance/`
  covering public APIs and the intended authoring experience.
- During development, you MAY run `pnpm --filter @sweatpants/acceptance test`.
- You MAY change the package filter and use focused test filtering, for example:
  `pnpm --filter @sweatpants/acceptance test <test-file>`.

## Land the Plane

Before completing work, you MUST run `pnpm land` from the repository root with
no filters. All gates must pass. Report failures accurately.

## Style

- Always use braces around control-flow bodies, including single-line returns.
  Write `if (condition) { return value; }`, never `if (condition) return value;`.

## Naming: define, create, install, use

- `define*` — immutable module-level declaration, evaluated once, no mutable
  state: `definePort`, `defineDurableEffect`, `defineDurableProgramManifest`.
- `create*` — constructs a runtime instance with its own state and lifetime:
  `createMemoryExecutionStore`, `createToolSessionRegistry`, `createChannel`.
- `install*` — binds an implementation or middleware into the current scope;
  the effect ends when that scope exits: `installDriver`, `installExecutionStore`.
- `use*` — reads a scoped capability inside an Operation: `useScope`,
  `useJournalAuthority`.

If calling it twice yields two independent stateful things, it is `create*`. If
calling it twice is meaningless, it is `define*`. If its effect is bounded by a
scope, it is `install*`.

## Generators

- Never use a bare `yield*` as an operand of another expression. Parenthesize it
  first: `(yield* operation())`. `yield*` binds more loosely than operators, so
  `yield* operation() || fallback` does not have the `await`-like precedence a
  reader may expect and can silently skip the right-hand branch.

## Git Operations (When Requested)

Git commits and pushes are **not automatic**. The agent will only perform git write operations when explicitly requested:

- "commit this" or "commit the changes"
- "push to remote" or "push it"
- "create a PR"
