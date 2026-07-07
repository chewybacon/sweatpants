# @sweatpants/session-contract

Wait-based session kernel contract package.

This package owns the leaf contract for sessions: log grammar types, deterministic wait-token helpers, derived status, in-memory reference/session utilities, projection helpers, and the conformance-kit testing entrypoint.

See [`docs/authoring-contract.md`](./docs/authoring-contract.md) for the portable authoring rules, durability tier table, and fate table required by REQ-047. See [`docs/legacy-agent-salvage.md`](./docs/legacy-agent-salvage.md) for the reference-only salvage artifacts retained while deleting the legacy agent sketches required by REQ-056.

## Entry points

- `@sweatpants/session-contract` — contract types, validators, helpers, in-memory reference session, and fresh fold-mode `createAgent` surface.
- `@sweatpants/session-contract/testing` — conformance adapter primitives and a machine-readable coverage matrix seed.
