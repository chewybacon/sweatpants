# Legacy Agent Salvage

This directory contains the named salvage artifacts required before deleting the legacy agent sketches.

- `salvage/legacy-projections.reference.ts` preserves the projection helper sketches from `packages/agents/src/projections.ts`.
- `salvage/legacy-commands.reference.ts` preserves the command vocabulary from `packages/agents/src/commands.ts` as projection-layer reference material.
- `salvage/core-agent-create.reference.ts` and `salvage/core-agent-types.reference.ts` preserve the `createContext`-scoped invocation and `.use()`/middleware patterns from `packages/core/src/agent` for fold-harness design reference.
- `authoring-contract.md` documents the ToolCtx⊂AgentCtx projection idea and the portable authoring contract for the wait-based session kernel.

The executable replacement is the fresh fold-mode `createAgent` exported by `@sweatpants/session-contract`. These files are non-runtime references only and MUST NOT be imported by package code.
