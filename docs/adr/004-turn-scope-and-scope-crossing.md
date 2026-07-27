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

## Three kinds of crossing

A scope boundary in local development stands in for a **process boundary in
production**. Keeping the two aligned is what makes the single-process dev loop
exercise the same constraints as a distributed deployment. Authored code that
reaches across a scope by capturing an object has quietly assumed shared memory,
and that assumption survives to a deploy where it is false.

That means "foreign bind" is not one thing. There are three, and the required
fix differs:

**1. Missing node.** Same process; the scope tree lacks a node the domain
already has. The model provider and tool runtime are this: the Turn exists in our
language but not in our tree. *Fix by modeling* — the crossing disappears.

**2. Deliberate ownership.** Same process; the object's configuration belongs to
itself rather than to its caller. The tool-session registry is this. *Fix by
binding once, at construction.* It is stable and will not disappear.

**3. Distribution boundary.** The far side may be another thread, isolate,
microVM, or machine. The token buffer and foreign tool sessions are this.
**`bind` is wrong here.** It holds a `Scope` and dispatches into it, which
assumes shared memory; across a process there is no scope to dispatch into. A
bound handle at a distribution boundary works in local development and cannot
work in production — precisely the class of defect local dev hides.

At a distribution boundary, only **serializable identity** may cross, and each
side resolves its own driver. The codebase already does this where it counts:

- `SessionRegistry.recover(sessionId, …)` takes an id and re-resolves
  `bufferStore.get(sessionId)` on the far side, gated by a writer fence
  (`ownerId` + `activationEpoch`). Identity crosses; the handle is rebuilt.
- The worker tool session cannot clone functions across `postMessage`, so the
  runner serializes schemas to plain JSON.
- AgentCore sessions cross as a `runtimeSessionId`, with handle and event stores
  installed on each side.

This is the same shape the durable model already names: `DurableReference`,
`StoredJson` inline-versus-reference, and opaque references by default.

It also reframes `useBackgroundTask` copying Contexts across a parentless scope.
That is a shared-memory shortcut: copying object references works locally and is
meaningless across a process. The port equivalent fails closed instead, which
looked like a regression and was the boundary telling the truth.

## Decision

1. **`Port.bind` is a signal, not a convenience.** Its docstring says so, and
   reaching for it is an instruction to first ask whether a scope is missing from
   the model.

2. **Foreign binds must be justified in place, and must name their kind.** The
   `sweatpants/documented-scope-crossing` lint rule requires a
   `// SCOPE-CROSSING:` comment, in the same spirit as `// SAFETY:` for double
   assertions. The comment must identify the crossing as *missing node* or
   *ownership*. If it is a *distribution boundary*, the bind itself is the defect:
   pass identity and re-resolve on the far side, with a fence if there is a
   writer.

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

## Evidence

`packages/framework/src/lib/chat/durable-streams/__tests__/turn-scope.test.ts`
builds both scope shapes and pins four facts:

1. With a parentless writer scope — what `useBackgroundTask` creates today — a
   seam installed by the request is **not** visible to the writer. That is the
   exact failure that forced `bind` into the handler.
2. With the writer descended from a Turn scope, the same lookup resolves with no
   `bind` at all.
3. A Turn-parented writer still runs after its request scope has been destroyed,
   so the durability property the orphan scope was protecting is preserved.
4. Destroying the Turn scope tears the writer down. The parentless scope cannot
   offer this: today nothing structurally reclaims a writer, which is a second,
   independent defect the same change fixes.

Point 4 was not part of the original diagnosis. Orphan scopes do not merely make
seams invisible; they place the writer outside structured concurrency entirely,
so its teardown depends on the task completing rather than on ownership.

## Consequences

- Two of three current crossings are provisional and should disappear when the
  Turn scope lands. That work is already queued alongside the Turn-scope join for
  cancellation and supersession (DR-030/REQ-030/REQ-049), which needs the same
  node for a different reason — further evidence the node is real.
- A new foreign bind that cannot cite a reason of comparable weight is a design
  review trigger, not a lint fix.
- Distribution boundaries gain a standing review question: *would this survive if
  the far side were another process?* Anything crossing that is not serializable
  identity is a defect regardless of whether local tests pass.
- Introducing the Turn scope is not free: the writer task's ownership currently
  comes from `useBackgroundTask`, which creates a scope with **no parent** and
  copies Contexts across explicitly. Ports install as scope middleware and are
  not copied by that mechanism, which is why the seam broke. Closing the gap
  means replacing that helper — already scheduled for deletion in the target
  architecture — and giving the Host an explicit Turn scope to parent writers
  with. That is why this ADR records the gap rather than closing it here.
- The change belongs with the `agent-host` extraction, which is the component
  that will own Turn lifetime. Doing it before that decomposition would mean
  doing it twice.

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
