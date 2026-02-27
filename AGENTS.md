# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd vc status          # Check Dolt branch and commit state
bd list --json        # Verify all issues are persisted
```

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Dolt-backed: Version-controlled SQL database, survives sessions
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update bd-42 --status in_progress --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task**: `bd update <id> --status in_progress`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Dolt Backend

bd uses Dolt (a version-controlled SQL database) for persistent storage:

- All issue state is stored in Dolt, not git
- The Dolt SQL server **auto-commits every write** (each `bd create`, `bd update`, `bd close` is immediately persisted)
- Use `bd vc status` to verify current branch and last commit
- Use `bd list --json` to verify all issues are persisted
- **Do NOT use `bd dolt commit`** - it is broken in the current version (throws "no store available"). This is safe to ignore because the server auto-commits.
- Beads state persists across sessions automatically

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

<!-- END BEADS INTEGRATION -->

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until beads state is checkpointed.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - `bd create` for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds must pass
3. **Update issue status** - `bd close` finished work, `bd update` in-progress items with notes
4. **Verify beads state** - This is MANDATORY:
   ```bash
   bd list --json        # Verify all issues are persisted with correct status
   bd ready              # Verify accurate picture of remaining work
   ```
   Since the Dolt SQL server auto-commits every write, your `bd create`/`bd update`/`bd close` calls are already persisted. The verification step confirms nothing was lost.
   
   **Do NOT run `bd dolt commit`** - it throws "no store available" and is unnecessary in server mode.
5. **Hand off** - Provide context for next session

### Execution Cadence

- Default behavior is to continue working through `bd ready` issues without pausing between completed items.
- Do not stop at a milestone unless blocked, quality gates fail, or the user asks to pause.
- When an issue is closed, claim the next highest-priority ready issue and proceed.

**CRITICAL RULES:**
- Work is NOT complete until beads issues are updated
- NEVER end a session with stale issue status
- Quality gates (tests, types, lint) must pass before closing implementation issues
- All discovered work must be captured as new issues
- You are not allowed to alter the beads or create new beads unless its to capture discovered problems that need to be followed up on

### Git Operations (When Requested)

Git commits and pushes are **not automatic**. The agent will only perform git write operations when explicitly requested:

- "commit this" or "commit the changes"
- "push to remote" or "push it"
- "create a PR"

The agent will confirm before any git write operations that modify history.
