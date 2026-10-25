# Foundation contracts

Shared types live here; journal and runtime implementations depend on them.

- `@sweatpants/foundation/computation`: `Outcome`, `RuntimeType`, `Computation`,
  `IterableOperation`, `Work`, `Handler`, `Middleware`, `HandlerMiddleware`,
  `Turn`, `Guest`, `GuestWork`, `Runtime`, and `RuntimeExecution`, plus `success`
  and `failure`. This module has no runtime-library imports. `Yielded` remains
  runtime-specific; structural compatibility alone does not promise durability.
- `@sweatpants/foundation/journal`: the prototype's `Identity`, `AcceptedExchange`,
  `Attempt`, `RetryMode`, `BeginAttempt`, `Snapshot`, `Journal`, `PendingJournal`,
  `RequestOccurrence`, and `Activation`. These are explicitly local, single-writer
  contracts. They do not promise distributed ownership or prescribe SQLite.
- `@sweatpants/foundation/json`: the shared JSON shapes and validation/encoding tools.

Computation types are also exported from the foundation root. Import their
`success`/`failure` constructors from `/computation`: the existing root constructors
belong to the parser, whose failure carries `issues` rather than an arbitrary `error`.
Journal contracts
use a dedicated entrypoint so generic names such as `Identity` and `Snapshot` retain
their context. The experimental primitive-journal package re-exports the contracts
for existing callers; it no longer defines its own copies.

## Why two JSON views?

`Json` allows mutation, which is useful when constructing JSON and for fresh parser
output. `ReadonlyJson` accepts deeply readonly arrays and objects as well as mutable
JSON; it is appropriate when a consumer should only read the value. A readonly array
cannot safely be passed to code that expects to push into a mutable array.

The prototype's former `Json` was exactly this readonly shape. Its compatibility
export now aliases foundation's `ReadonlyJson`. New journal contracts use the
explicit name. These are two access views of JSON, not competing data formats.
Neither type validates unknown input or freezes an object at runtime.

## Two execution lifetimes

`RuntimeExecution<T>` is the Promise-facing handle returned by `Runtime.start`:
await its result or cancel and await cleanup. Foundation's existing
`Execution<Request, Reply, Output>` is a resumable cursor: cancellation can reach
another boundary, and physical disposal is separate. Their signatures and
cancellation semantics differ, so they are not aliases. Primitive-journal retains
`Execution` as a compatibility alias for `RuntimeExecution`.

## Encoding is a separate contract

The prototype still owns its `encode` and `parseOutcome` functions. Foundation's
`canonicalJson` validates and detaches values, checks Unicode/cycles/property
descriptors, and accepts null-prototype objects. The prototype encoder has different
admission rules: for example, it rejects null-prototype objects, accepts lone
surrogates, and reads enumerable values through `Object.entries`.

Consolidating the TypeScript shape does not make these validators interchangeable.
Changing persistence admission rules needs an explicit compatibility decision;
moving the types does not change existing stored bytes or replay equality.
