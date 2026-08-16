# Tool invocation host: two shapes

Style experiment for the seam the original PoC depended on, and the one whose
name has aged worst.

Run with:

```bash
pnpm --filter @sweatpants/tool-runtime-local exec vitest run src/styles
```

## What is actually being modeled

`ToolSessionRegistry` is named for its least interesting property. Lookup is
incidental. What it provides is a **host for addressable, resumable tool
invocations**:

```
tool generator (usually in a worker thread)
  runs under a long-lived host scope
  parks when it needs a sample or elicit
  a later request attaches by id and answers it
  terminal result releases the execution
```

The degenerate invocation here is a generator that suspends on a queue until a
response arrives. That stands in for the worker, and it preserves the property
under test: **the execution outlives the scope that started it**.

`bookFlight` is the PoC's shape — elicit, then sample, then return.

## The property the PoC needed

Three tests pin it:

- a parked invocation survives the exit of the request scope that started it;
- request A parks, request B answers the elicit, request C answers the sample,
  and the body resumes each time exactly where it suspended;
- the last reader leaving while the body is parked does not evict it.

That last one is the reconnect rule. Reference counts govern readers, not the
execution.

## The design question: what can a scope observe?

Both styles run the same three-request flow. The only difference is whether
`turn`/`respond`/`cancel` are port members or handle methods.

**Style H (handle)** mirrors production. `HandleHost` hands out an
`InvocationHandle`; lifecycle calls go through the port, but the interaction
does not. Scope middleware observes:

```
start:booking
attach:booking
attach:booking
release:booking
```

Every turn, every sample, every elicit response is invisible. Middleware can
count acquisitions and nothing else.

**Style F (facade)** makes every operation a port member keyed by invocation
id. The same flow yields:

```
start:booking
turn:booking:parked
respond:booking:booking:req:1
turn:booking:parked
respond:booking:booking:req:2
turn:booking:completed
release:booking
```

That is the difference in one artifact. Policy that needs to see a tool asking
for input — audit, elicit authorization, sampling budgets, cancellation
propagation, tracing a park/resume across requests — is expressible in F and
not in H.

## Cost of style F

Not free, and the experiment does not pretend otherwise:

- every operation takes an id, so the caller carries a string instead of an
  object handle;
- the host must resolve the id on each call and raise `InvocationNotFound`
  itself, rather than letting a captured reference stay valid;
- a handle is a natural place to hang typed per-invocation state; a keyed
  facade is not.

## Scope shadowing

The final test installs a second host in a child scope using the same
invocation id. The child's `start`/`turn`/`respond` resolve to the child's
invocation while the parent's stays parked and untouched. Invocation identity
is per-host, not global — the same rule Ports already give drivers.

## Status

Experiment only. No production migration. It does not model worker spawn
failure, replayable event logs with LSN cursors, durable continuations, remote
(AgentCore) handles, or retention. Those are the parts that decide whether the
production seam can move.

The naming conclusion stands on its own though: whatever shape wins,
`ToolSessionRegistry` should be `ToolInvocationHost`, and `ToolSession` should
be `ToolInvocation`. "Session" is overloaded four ways in this codebase
(conversation, response tail, model, HTTP), and "registry" describes the map it
happens to keep rather than the executions it owns.
