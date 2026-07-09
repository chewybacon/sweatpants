# Archived Documentation

This directory contains outdated or superseded documentation that is kept for historical reference.

## Current Documentation

For up-to-date **product** documentation, see:

- [Root README](../../README.md) — product happy path
- [Product surface / lanes](../product-surface.md) — facade allowlist + import policy
- [Product demos](../demos/) — reconnect, elicit pause/resume, MCP HITL

Framework internals and historical design notes live under `packages/framework/docs/`
(including archived isomorphic-tools material). Isomorphic tools are **not** the
product tool authoring path — use `createTool` from `@sweatpants/core`.

---

## Files in This Archive

### framework-v1/ (from packages/framework/docs/)

Archived during the January 2026 documentation restructure.

#### agent-context-design.md
**Status:** Superseded  
**See instead:** `packages/framework/docs/isomorphic-tools.md`  
**Reason:** Used deprecated `defineIsomorphicTool()` API. Current API uses `createIsomorphicTool()` builder pattern. Context types have been renamed (`ClientToolContext` → `BaseToolContext`, etc.).

#### notes.md
**Status:** Historical design exploration  
**Reason:** Exploratory notes from development. Concepts are now implemented and documented in the main docs.

#### rendering-checklist.md
**Status:** Historical implementation tracker  
**Reason:** Tracked features during development. All items complete. Current status is reflected in the main documentation.

#### CLEANUP.md
**Status:** Historical maintenance tracker  
**Reason:** Documented cleanup work completed in December 2025.

#### SESSION-CONTEXT.md
**Status:** Superseded  
**See instead:** `packages/framework/docs/isomorphic-tools.md`  
**Reason:** Context design has been simplified and integrated into the main tool documentation.

#### migration-guide.md
**Status:** Superseded  
**See instead:** `packages/framework/docs/pipeline-guide.md`  
**Reason:** Migration from settlers to pipeline is complete.

---

### settlers.md
**Status:** Superseded  
**See instead:** `packages/framework/docs/pipeline-guide.md`  
**Reason:** The settlers API has been deprecated in favor of the frame-based pipeline system.

### processors.md
**Status:** Superseded  
**See instead:** `packages/framework/docs/pipeline-guide.md`  
**Reason:** Documentation has been moved to the framework package with updated examples.

### processor-design-notes.md
**Status:** Outdated design notes  
**Reason:** Historical design discussion notes from the processor/settler architecture era.

### refactor-plan-effection-chat.md
**Status:** Historical planning document  
**Reason:** Planning document from a past refactoring effort.

### chat-streaming.md
**Status:** Uses deprecated API  
**Reason:** References the old settler-based streaming API.

---

## Why Archive Instead of Delete?

We keep these files for:
- Historical reference and understanding decision-making
- Learning how the architecture evolved
- Context for code archeology and git history
