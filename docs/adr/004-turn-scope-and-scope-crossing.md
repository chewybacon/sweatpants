# ADR-004: The Turn scope, and what `Port.bind` is telling us

- **Status:** Accepted
- **Date:** 2026-07-27
- **Related:** ADR-001 (one crank turner), ADR-002 (one Host-owned reconnect log), DR-007/DR-030, REQ-030/REQ-049

## Context

Ports resolve their driver at call time by walking *up* the Effection scope tree
from wherever the call happens. That is the property that makes them
substitutable, observable, and fail-closed.

`Port.bind(scope)` defeats that walk on purpose: it returns a handle whose calls
dispatch against a named scope regardless of where they are made. It is not a
driver handout — middleware still applies and the seam still cannot be
bypassed — but it does hard-code an answer to "who is my driver?".

We introduced it because converting the model provider and the tool runtime to
ports broke roughly twenty-five tests at once. The cause was not the conversion.
It was that both seams are configured in the **request scope**, while the work
they serve finishes in a **Host-owned writer task** that is deliberately not a
child of that request:

```
app scope
  ├── request scope        installs model provider (selected from request body)
  └── writer task          engine runs here; outlives the request
```

Before ports, this worked by accident. The code pulled the driver *object* out of
a Context and passed it along; a plain object has no opinion about scopes, so the
mismatch was invisible. The port made an existing structural fact visible.

## The observation

Every legitimate use of `bind` so far points at the same thing: **our scope tree
is missing a node that our domain already has.**

The glossary defines a **Turn** as one human message carried through to a
terminal agent result, including all model, tool, and sub-agent loops. That is
precisely the lifetime that spans request *and* writer. It is the unit that owns
the model selection, the tool runtime, and cancellation.

We have no scope for it. What exists is a request scope that ends too early and a
writer task that begins detached, with the Turn straddling both:

```
app scope                       app scope
  ├── request scope       vs      └── turn scope         ← what the domain says
  └── writer task                       ├── request scope
                                        └── writer task
```

With a Turn scope, both seams would be installed on the Turn, the writer would
inherit them by ordinary lookup, and `bind` would be unnecessary at those sites.

## Decision

1. **`Port.bind` is a signal, not a convenience.** Its docstring says so, and
   reaching for it is an instruction to first ask whether a scope is missing from
   the model.

2. **Foreign binds must be justified in place.** The `sweatpants/documented-scope-crossing`
   lint rule requires a `// SCOPE-CROSSING:` comment naming the work that is not a
   child of the configuring scope, in the same spirit as `// SAFETY:` for double
   assertions. If the work cannot be named, the bind is not the right answer.

3. **Self-binds are exempt.** `Port.bind(yield* useScope())` pins a port to the
   caller's own scope. Dispatch is unchanged; the call only materializes the port
   as a plain interface handle so an accessor can return the declared type. No
   scope is crossed, so no justification is required. The rule distinguishes the
   two cases syntactically.

4. **The count is the metric.** Foreign binds measure the distance between our
   scope tree and our domain model. Two is a known gap. A dozen would mean the
   tree is wrong.

## Current foreign binds

| Site | Verdict | Reason |
| --- | --- | --- |
| `handler.ts` — model provider | Justified, pending Turn scope | Provider is selected per request from `body.model` against an allowlist, so it cannot move to app startup. The engine consuming it runs in the writer task. Removed by introducing a Turn scope. |
| `handler.ts` — tool runtime | Justified, pending Turn scope | Same cause, same fix. Tool calls are issued by the engine from the writer task. |
| `session-registry.ts` — tool session store | Justified, different reason | The registry is a resource owned by its own scope whose methods are invoked from arbitrary request scopes. The store is a property of the registry, not of the caller. Resolved **once** at construction rather than per call. A Turn scope would not change this. |

The first two share one root cause and one fix. The third is a distinct and
narrower case: an object whose configuration belongs to itself rather than to its
callers. It would be wrong to "fix" it with a Turn scope.

## Consequences

- Two of three current crossings are provisional and should disappear when the
  Turn scope lands. That work is already queued alongside the Turn-scope join for
  cancellation and supersession (DR-030/REQ-030/REQ-049), which needs the same
  node for a different reason — further evidence the node is real.
- A new foreign bind that cannot cite a reason of comparable weight is a design
  review trigger, not a lint fix.
- Introducing the Turn scope is not free: the writer task's ownership currently
  comes from the durable-streams session registry, so the Turn scope must own or
  parent that task without weakening the guarantee that a response keeps
  streaming after its request ends. That is why this ADR records the gap rather
  than closing it in the same change.

## Alternatives considered

**Pass driver objects across scopes, as before.** Rejected: it silently escapes
the seam, so scenario middleware — latency, fault injection, deadlines — does not
apply to precisely the code path that runs the model.

**Install the seams at app scope.** Rejected: model selection is per request and
allowlist-validated. Installing at app scope would either pin every request to
one model or reintroduce mutable global state.

**Make `bind` unavailable.** Rejected: the writer task genuinely is not a child of
the request, and the `session-registry` case is legitimate and unrelated to the
Turn. Removing the capability would push callers back to passing raw drivers,
which is strictly worse.
