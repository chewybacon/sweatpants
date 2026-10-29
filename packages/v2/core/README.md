# Framework authoring primitives

`defineEffect` creates an immutable, runtime-independent journaled exchange definition.
It supplies a stable key, a context schema and a typed Guest callable. A default handler
returns `Outcome` and infers both success and failure types. An optional response schema
transforms only successful values. Schema-only declarations retain unknown failure data.

Definitions own no installed driver, grant, native scope or journal. Use
`createEffectCapabilities` from `@sweatpan.ts/hosting` to install implementations and
select grants. Calls suspend for delivery; constructing a definition does not run work.
The journal owns request/reply correlation. Dynamic registry lookup erases heterogeneous
types internally while direct calls retain their definition's inferred contract.

Core depends on portable computation and Standard Schema types. It does not load a
runtime, database, model provider or test rig. General computation/composition types
remain in `@standard-durability/core`.
