# Elicit support negotiation experiment

A flight tool requires both `pickFlight` and `pickSeat`. A frontend registers typed
handlers using `defineElicitPlugin(chooseFlight).onElicit({ ... })`. Partial
registration is useful: a server seat-selection handler can complete the coverage.
Projection is internal to the builder; callers pass the authored tool directly.
Handler yield requirements are inferred, so registration needs no explicit runtime
type argument. A handler with no runtime yields remains portable across runtimes.
The registration advertises only tool identity and handled
elicit names. The server chooses from its already-permitted tool inventory; client
advertisements cannot introduce tools or grant permission.

`selectToolSupport` requires coverage of every declared elicit. It reports missing
names, ignores unrelated tool advertisements, and gives server
handlers precedence when both sides support an elicit. The application supplies its
server handler inventory. A tool with no elicits requires no frontend support.

The selected routes are retained in the root journal's admission input. The flight
journey reconstructs its binding from that input after SQLite reopen, validates the
selected tool and routes, and installs server handlers through the existing
`installElicitHandlers`. Client routes use the host's existing participant waits.
Reconnecting with no handlers cannot change a parked question into a server call.
A compatible frontend can subsequently respond using the retained selection;
`chat.answer` validates the outcome and exact grant. Answering never drives work.
The model catalog comes from these selected server bindings.

The typed declaration, responder and coverage boundaries are now exported by
`@sweatpan.ts/tools`. This is capability/policy assembly, not a new primitive or a
promoted `useChat` contract.
The helper is framework neutral; actual handler execution is explicit and owned by
the caller's runtime task. It does not auto-dispatch on observation, provide a
multi-tab execution lease, guarantee a client remains connected, or reroute a
previously admitted question when capabilities disappear. A disconnected or
incompatible client leaves the interaction parked for a compatible participant.

Coverage is matched by tool identity and declared elicit aliases. There is no manual
plugin revision or automatic schema compatibility proof. Keep shared definitions
compatible with retained work and use distinct program/tool identities for incompatible
authored changes. The local projection retains schema references and is not a
browser-safe extraction mechanism. Authentication, wire limits, generated schema identities and provider/context registration DX remain
outside this experiment. The shared declarations and responder now live in `@sweatpan.ts/tools`; the React
adapter, wire schemas and frontend dispatcher remain in `apps/yo-chat-v2/src`. The React experiment
below remains useful for evaluating the contract without promoting a framework API.

Evidence: `elicit-support.acceptance.test.tsx` executes the real flight tool/chat
host under Effect and Effection with SQLite reopen, simulated model responses,
typed client handlers, server fallback, precedence, incompatible/missing coverage,
unknown advertised tools and retained answer grants. `elicit-support.typecheck.ts`
checks context inference and rejects wrong elicit names and response types. These
are in-process journeys, not browser, network-disconnect or process-crash evidence.

## Handler context and React presentation

`args.context` carries the validated, typed elicit input. `ctx.interaction` contains
frozen execution, program, elicit key, request and resolution identities. A frontend
adapter declares its capability vocabulary through `defineElicitPlugins<Capabilities>()`.
`createElicitResponder` binds concrete capabilities to a declaration, independently
for each session; the headless definition adds none. V1 also supplied an authored message and a separate third metadata
argument. V2 has no message field in its effect contract, so this experiment does
not invent one; metadata is grouped under the second argument.

The React adapter is constructed once for a frontend session:

```tsx
const frontend = createReactElicitHost(runtime);
const flightPlugin = frontend.definePlugin(chooseFlight).onElicit({
  *pickSeat(args, ctx) {
    const value = yield* ctx.render(SeatPicker, args.context);
    return { ok: true, value };
  },
});
```

`SeatPicker` declares its reply through `onRespond`; the adapter supplies that prop.
`render` infers the remaining props and its reply, so a component returning a flight
ID cannot satisfy the seat handler. Handler code captures no runtime. The existing
`Outcome` remains explicit; rendering completes with a value, not an acceptance
receipt. Automatically wrapping success or changing decline/cancel authoring would
be another design choice.

The session's `ElicitViews` component subscribes to local render slots keyed by exact
question identity. Each render acquires an existing Signal subscription before
publishing its component, then waits in a child scope. The first callback wins;
scope cleanup removes the slot and disables retained callbacks. A concurrent render
of the same question in that host is rejected. This is local presentation ownership,
not a distributed handler claim or exactly-once dispatch.

View unmount is subscription disposal only. The caller explicitly owns the handler
task, cancellation, answer submission, receipt handling, subsequent advancement and
snapshot refresh. On disconnect that owner cancels the task; the journal question
remains parked. Reconnect reads the retained question and selection, creates a new
frontend session and starts a new handler. Old callbacks cannot complete its render.
Selection removes temporary UI before answer acceptance; accepted history must still
come from the authoritative conversation view. No React elements are persisted.

### What this establishes

- **Existing primitives suffice:** runtime scope cleanup owns presentation lifetime,
  Signal delivers a reply, journal grants own acceptance and replay.
- **Frontend adapter:** typed `render` and observable local slots are React-specific.
  Other frontends can supply their own capabilities against the same handler contract.
- **Application assembly:** selected plugin registration and explicit handler task
  ownership remain outside `useChat`. Mounting a message component should not create
  another handler owner.
- **Application follow-up:** yo-chat-v2 now owns a frontend dispatcher that reconciles
  snapshots, deduplicates local handlers, removes obsolete renders and retains an
  ambiguous answer for explicit identical retry. Its demo flight and seat pickers
  sit under their assistant turn. General nested tool history, module-level plugin
  registration, cross-tab ownership and durable browser retry storage remain open.

The real flight journey now mounts a React seat picker under both runtimes, unmounts
and remounts the view, cancels the waiting local task, reopens SQLite, reconstructs
the picker, ignores a stale callback, accepts one of two rapid replies, explicitly
submits it and completes the chat. Static checks verify component props, reply types
and immutable correlated metadata. This is DOM acceptance evidence, not a live
browser/network journey; no additional durability primitive was needed.
