# Scheme Execution evaluator

The checkpoint evaluator executes Scheme source in Hoot/Wasm. It keeps explicit
portable evaluator frames, lexical environments, shared cells and unwind state.
It does not execute a TypeScript bytecode interpreter. The compiler emits Scheme;
the runtime validates, links and evaluates it.

Capture is read-only. Fresh instances restore at the same boundary without
repeating accepted effects. Normal completion, throws and cancellation run
registered cleanup; cleanup may itself suspend. Disposing compute does not
perform logical unwind. Kernel/backend integration uses the existing shared
attachment and journal authority.

The package's execution tests cover composition, installed effects, authority
reconstruction, checkpoint validation, lexical scope, shared captures, cleanup and
inspection projection. `no-bytecode.mjs` rejects transitive reference-interpreter
imports in the deployed runtime path. Reference evaluators remain test oracles.

The Playground evaluator remains separate, with its existing supported language,
validation limits and replay behavior. Neither evaluator supports durable timers
or the experimental scoped scheduler.
