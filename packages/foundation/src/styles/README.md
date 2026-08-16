# Execution store seam: six styles

Unstaged spike. Same contract, same tests, six shapes. Run with:

```bash
pnpm --filter @sweatpants/foundation test
```

|                                    | A: api as port                     | B: derived facade        | C: explicit facade (shipped)     | D: typed port   | E: context-backed facade         | F: context-injected API facade    |
| ---------------------------------- | ---------------------------------- | ------------------------ | -------------------------------- | --------------- | -------------------------------- | --------------------------------- |
| Declarations per operation         | 1                                  | 2 (interface + key list) | 3 (interface + facade + adapter) | 1               | 3 (interface + context + facade) | 3 (interface + contexts + facade) |
| Typed generic seam                 | n/a                                | `createDriverApi<T>`     | n/a                              | `definePort<T>` | explicit interface               | explicit interface                |
| Adapter shape                      | middleware                         | plain object             | plain object                     | plain object    | plain object                     | plain object                      |
| Direct adapter conformance         | no                                 | yes                      | yes                              | yes             | yes                              | yes                               |
| Context exported / seam bypassable | no                                 | yes                      | yes                              | no              | yes                              | facade only                       |
| Middleware order sensitivity       | none once driver installs at `min` | none                     | none                             | none            | API-only                         | API-only                          |
| Fail-closed with nothing installed | yes                                | yes                      | yes                              | yes             | yes                              | yes                               |
| Teachability                       | medium                             | medium                   | highest                          | high            | high                             | high                              |
| Deep nested injection              | via API                            | via exported context     | via exported context             | no context      | raw `Context.expect()`           | facade via `Context.expect()`     |

## Ordering, corrected

`api-internal.js` builds the stack as `combine(max.concat(min))` with `around` defaulting to `at: "max"`. A terminal driver installed at the default therefore sits outside later middleware and makes it unreachable. Drivers must install at `min`; policy and observation middleware use the default `max`.

Both orderings are now asserted for every style:

- `supports observation middleware installed after the driver`
- `supports observation middleware installed before the driver`

## Style E

`style-e-context-backed-port.ts` is an experiment for trusted framework
composition. The module-level API remains the middleware seam, while its
terminal implementation resolves the installed driver through
`Context.expect()`. The `useStoreE()` helper returns that context-injected
implementation without capturing or rebinding a scope.

The focused test verifies that a middleware layer installed in an outer scope
still wraps an API call made from a deeply nested scope after the driver is
installed in an intermediate scope.

This style intentionally exposes the implementation context. It is not yet a
production recommendation; it exists to test whether explicit trusted DI gives
us the composability we want without the `Port.bind(currentScope)` pattern.

## Fold adoption experiment

`fold-adoption-style.ts` models `indexRecordProjection` — the worst production
case, five separate loops over the same records — and adds the combinators
full adoption needs beyond `combine`:

```
mapFold    functor  — post-process completed accumulators
prefilter  narrows which items a fold does work for
```

It tests, and refutes, a claim made by the fusion experiment: that a phase
depending on another phase's output forces a second traversal. Resolving model
message identities needs the _completed_ `prepared` map from a different fold,
yet stays in one pass, because `done()` sees every accumulator. It is `map`
over a combined fold, not a second phase — and it resolves correctly even when
the `prepared` record arrives after the emission it describes.

A second traversal of the source is required only when a phase must re-read
items with knowledge derived from them. None of our three derivations do.
Corrected rule:

```
applicative combine  — independent accumulators
functor    map       — post-processing over completed accumulators
monadic    stages    — only for re-traversal or effects
```

Cost, stated honestly: resolving in `done()` buffers intermediate data rather
than re-reading the source. Bounded by the window here, but it is memory
traded for passes.

## Fold fusion experiment

`fold-fusion-style.ts` models the _inside_ of an indexed derivation, where the
projection-program abstraction is the wrong tool. Programs compose dependent
phases — `yield*` is a data dependency, so every stage owns a traversal.
Several indexes computed from the same items do not feed each other, so
splitting them into stages would trade one traversal for N.

Independent-and-combinable is applicative. A `Fold` hides its accumulator in a
closure, so folds with different accumulator types combine with no existential
and no cast at the call site:

```ts
const baseIndexes = combine({ ids, byTag, slots, edges }); // one traversal
```

The degenerate domain is a graph whose `parent` may name an id that never
arrives. Four indexes fuse into one pass; partitioning edges into
attached/pending genuinely needs the complete id set, so it is a second pass.
That mixture — a short monadic spine of applicatively fused stages — is the
shape of `refreshDerivedState`, `indexRecordProjection`, and
`indexedTaskRecords`.

What the tests measure:

- fused: visits == items. Unfused (the shape `indexRecordProjection` is written
  in today): visits == items × 4.
- composed output is identical to the hand-fused loop.
- the spine keeps the dependent phase explicit while the scan stays one pass.
- failures are attributed to the fold that raised them (`FoldError.foldKey`),
  and dependent-phase failures report their stage path.

Rule of thumb: monadic composition for dependent phases, applicative
composition for independent accumulators, and never decompose a fused
traversal into stages just to name it.

## Derived view experiment

`derived-view-style.ts` models the proposed decomposition of the chat
projection fold (`chat-core/src/chat-client-projection.ts`). Two styles fold
the same event vocabulary:

- **Style M (maintained)** mirrors production: edges keyed by physical node
  id, five indexes updated by hand on every mutation, and child-migration
  surgery (`migrateProvisionalMessage` ↔ `replaceSyntheticMessageNode`) when a
  synthetic message node is replaced by its authoritative placement.
- **Style D (derived)** keys edges by stable logical identity
  (`ParentRef = node | message | root`). The fold state is two fields; every
  index is one O(n) derivation memoized on the identity of the nodes map.

What the tests demonstrate:

- Style D is order-independent: all 24 permutations of a conversation
  materialize identically. Style M fails exactly the 12 permutations where an
  authoritative child precedes its message placement.
- Pending children are a derived category: transitive attachment needs no
  fold-time recursion (`attachPending` disappears).
- Conflicts (sibling sequence, double placement) surface on the same event in
  both styles when derivation runs eagerly per structural fold.
- Content deltas reuse the nodes map, so the WeakMap-keyed view survives them:
  50 text folds cost zero re-derivations.

Deliberately not modeled: mutable-fact merge rules, the structured-output
streaming cursor, and `messageOrder` arrival semantics. No generators are
involved — this decomposition is data modeling, not composition.

## Projection program experiment

`projection-program-style.ts` is the shape that came out of the pipeline
experiments. A projection is one generator program; `yield*` delegation _is_
the bind, so intermediate types thread automatically. There is no stage array,
no builder, and no existential cast, and ordinary control flow works:

```ts
function* providerProjection(roots) {
  const state = yield* stage("roots", function* () {
    yield* note({ kind: "root-input", count: roots.length });
    return projectionFromPublicRoots(roots);
  });

  if (isEmpty(state)) return [];

  return yield* stage("provider", function* () { ... });
}
```

The program yields instructions (`note`, `enter`, `exit`); the runner
interprets them, accumulating notes, tracking the nested stage path, observing
events, and converting a thrown domain error once. The same program can be run
by different interpreters — plain, traced, or collected.

A rejected alternative — an explicit stage-array pipeline with a `.through()`
builder — was prototyped and deleted. It required reifying a heterogeneous
list of Kleisli arrows, which forced a builder plus one existential type
erasure, and a static chain cannot express branching or loops between stages.
`yield*` delegation provides the same sequencing with none of that machinery.

## Generic Resolver experiment

`resolver-style.ts` and `resolver-style.test.ts` exercise the proposed generic
Resolver shape separately from the execution-store styles. The experiment
covers required and fallback resolution, middleware installed before and after
implementation, nested `around` ordering, short-circuit policy, and one facade
inherited across child implementation scopes.

It is intentionally not exported as production foundation API yet.

## Style F

`style-f-context-api-facade.ts` keeps the raw driver in a private context but
stores the module-level API operations in the trusted use-context. A caller
using `useStoreF()` receives the API facade, not the raw driver, so nested calls
continue through outer and inner API middleware.

The focused tests verify both identity facts: the injected value is the API
facade rather than the raw driver, and its calls preserve the complete nested
middleware chain.

## Style D

`definePort(name, portDeclaration)` uses the declaration as three things at once: the contract type, the runtime key list, and the fail-closed default. `installDriver(plainObject)` adapts an ordinary adapter into terminal middleware at `min`.

That keeps:

- A's non-bypassable seam, because no Context is exported and there is no `useStore()` accessor;
- B's typing, because everything derives from one generic declaration;
- C's plain adapters and readable call sites, because drivers are ordinary objects and callers write `StoreApi.operations.load(id)`.

Remaining cost: the port declaration bodies are stubs that only call `unavailable()`, which is mild ceremony, and `installDriver` needs one `SAFETY` cast internally.

## Recommendation

D for `ExecutionStore` and the tool-session store, with C's explicitness preserved at the call site. If third-party driver authors ever need to see an interface rather than infer it, export `type ExecutionStore = ...` derived from the port, as shown in `style-d-typed-port.ts`.
