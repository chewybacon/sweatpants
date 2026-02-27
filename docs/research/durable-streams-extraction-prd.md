# PRD: Durable Streams Internal Extraction + Stabilization

Date: 2026-02-27
Owner: framework/durable-streams
Status: Draft for implementation

## Background

The durable-stream protocol work is functionally strong inside `@sweatpants/framework`, but core protocol responsibilities are still mixed with chat orchestration concerns. We now want to extract durable-stream protocol primitives into an internal package (`@sweatpants/durable-streams`) and stabilize semantics before considering publish/externalization.

This phase is internal-first and optimized for one acceptance target: preserve behavior needed for framework usage and keep yo-chat e2e tests green.

## Problem Statement

Current durable-stream logic spans protocol transport, stream lifecycle, and framework orchestration in ways that make reuse and independent hardening difficult. We need:

1. A clear package boundary for protocol + core stores + adapters.
2. Retention semantics that are intelligent by default and consumer-configurable.
3. A robust migration path that allows breaking internal imports while preserving product behavior.

## Goals

1. Extract durable-stream protocol core into `packages/durable-streams` as `@sweatpants/durable-streams`.
2. Keep framework-specific chat orchestration in `@sweatpants/framework`.
3. Implement configurable retention policy with default auto-delete on successful close.
4. Lock protocol behavior as close to spec as practical; document temporary divergences.
5. Stabilize concurrent delete/read/write behavior under extracted architecture.
6. Pass framework quality gates and yo-chat e2e.

## Non-Goals (This Phase)

1. External npm publishing and semver stability guarantees.
2. Worker/edge broad runtime support beyond what current yo-chat e2e requires.
3. Full concrete Redis/Postgres production hardening beyond existing internal baseline.

## User Requirements (from product/engineering)

1. Package name and location: `@sweatpants/durable-streams` in `packages/durable-streams`.
2. Scope: protocol, stores, adapters only.
3. API churn is acceptable during extraction.
4. No backward-compat bridge required during migration.
5. Runtime requirement in this phase: whatever is needed for yo-chat e2e to pass.
6. Default retention: auto-delete successfully closed streams.
7. Divergences from protocol are acceptable if explicitly documented.

## Functional Requirements

### FR-1 Package Boundary

Move into durable-streams package:

- Protocol header parsing/formatting.
- Read transport behavior (catch-up, long-poll, SSE).
- Mutation transport behavior for stream lifecycle endpoints.
- Stream formatting (NDJSON/SSE control/data framing).
- Core durable stream types and generic in-memory store.
- Adapter interfaces and concrete internal adapters currently available.

Keep in framework package:

- Chat engine and provider orchestration.
- Framework-specific request body modeling for chat POST flow.
- Tool/plugin/session orchestration not needed by protocol core.

### FR-2 Retention Policy

Retention strategy must be configurable by consumers:

- `auto_delete_on_close` (default)
- `retain_until_ttl`
- `retain_forever`

Policy must apply consistently across in-memory and pluggable stores.

### FR-3 Protocol Behavior

Maintain protocol behaviors already implemented:

- URL-based addressing (`/sessions/{id}`)
- offset sentinels (`-1`, `now`)
- long-poll and SSE live modes
- snapshot headers (`Stream-Next-Offset`, `Stream-Up-To-Date`, `Stream-Closed`)
- `ETag` and `If-None-Match`
- protocol-native mutating operations (`PUT` create, `POST` append/close, `DELETE`)

### FR-4 Concurrency and Safety

Delete/read/write interactions must be deterministic and tested. No leaked runtime tasks or unhandled async errors are acceptable.

## Acceptance Criteria

1. New package exists and framework compiles against it.
2. Durable protocol tests in framework pass after extraction.
3. yo-chat durable and full e2e suites pass.
4. Retention policy default is auto-delete-on-close and is configurable.
5. Documented protocol divergence section exists and is current.

## Test Plan

1. Unit tests for extracted protocol helpers and transports.
2. Existing framework durable test matrix remains green.
3. Integration tests for adapter/store paths where available.
4. yo-chat e2e as end-to-end acceptance gate.

## Risks

1. Hidden coupling between handler orchestration and protocol transport.
2. Delete/read/write race conditions during migration.
3. Behavioral regressions due to retention default change from current state.

## Rollout Plan

1. Extract package internals and wire framework consumers.
2. Stabilize semantics and tests.
3. Close extraction epic after acceptance gate is green.
4. Create follow-up for deeper adapter hardening if needed.
