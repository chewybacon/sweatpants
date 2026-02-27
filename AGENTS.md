# Agent Instructions

This project uses **Tasuku (`tk`)** for issue and task tracking.

If `tk` is not on your `PATH`, either:

- run commands as `"$(go env GOPATH)/bin/tk" ...`, or
- add Go binaries to your shell path: `export PATH="$(go env GOPATH)/bin:$PATH"`.

## Quick Reference

```bash
tk task ready                   # Find unblocked work
tk task show <id>               # View task details
tk task start <id>              # Mark task in progress
tk task done <id>               # Mark task complete
tk task add "Title"             # Create a new task
tk task list --status in_progress
tk task list --status ready
```

## Task Tracking Rules

- ✅ Use `tk` for all work tracking.
- ✅ Track discovered follow-up work with `tk task add`.
- ✅ Keep task state accurate (`ready`, `in_progress`, `blocked`, `done`).
- ❌ Do not use any tracker other than `tk` for new work.
- ❌ Do not keep separate markdown TODO trackers.

## Suggested Agent Workflow

1. Check available work: `tk task ready`
2. Start a task: `tk task start <id>`
3. Implement, test, and document changes
4. Add discovered work: `tk task add "..."`
5. Finish and close: `tk task done <id>`

## Landing the Plane (Session Completion)

Before ending a coding session:

1. Run required quality gates for touched code.
2. Ensure active work is reflected in Tasuku state.
3. Verify handoff visibility:

```bash
tk task list --status in_progress
tk task list --status ready
```

## Git Operations (When Requested)

Git commits and pushes are **not automatic**. The agent will only perform git write operations when explicitly requested:

- "commit this" or "commit the changes"
- "push to remote" or "push it"
- "create a PR"
