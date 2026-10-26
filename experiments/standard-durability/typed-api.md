# One declaration, two bindings, one public facade

Experimental scaffold with focused behavioral verification under both runtimes.
No production migration. Read `payments.ts`, then `packages/standard-durability/src/api-definition.ts` and local `api-bindings.ts`.

## Authoring

```ts
const PaymentDefinition = defineApi("example.payments", {
  charge: operation({
    version: "1",
    retrySafety: "unsafe",
    input: ChargeInput,
    success: Receipt,
    failure: PaymentDeclined,
  }),
});

const host = createHost(composition);
const Payments = bindApi(PaymentDefinition, host);

yield * Payments.operations.charge({ account: "acme", amount: 10 });
yield * Payments.host.install(provider);
yield * Payments.host.around(middleware);
```

The guest call belongs inside the authored work; installation and middleware belong
in the host scope before driving that work. They are different yielded protocols.
`payments-journal.ts` shows the actual composition using the existing driveJournal.
The payment provider is illustrative, not a live payment processor.

The facade is only:

```ts
{
  operations: guest.use(PaymentDefinition),
  host: host.use(PaymentDefinition),
}
```

Both explicit views remain available. Host binding caches the declaration/facade,
not an execution scope. `install`, `around` and calls resolve their executing scope
through the existing composition adapter. Use one Host registry for a framework
assembly; it rejects different declaration objects claiming the same API ID.
Names must also remain unambiguous in the shared composition scope tree.

## Type information

Input, success and failure schemas implement Standard Schema V1. Declarations
import its types only, never Zod or a native runtime. The example uses Zod.
`GuestOperations` maps each method to a portable request computation returning its
own Outcome. `Signature` maps the declaration to native provider/middleware methods.
The second example method, lookup, has different arguments and error/success shapes.

The scaffold retains Standard Schema input/output inference. Its implementation
currently admits only synchronous, JSON-preserving validators. Async validation
fails explicitly (and observes any rejected validation promise); transforms,
coercion/default insertion and stripping unknown keys fail if the validated value
changes the canonical JSON. That prevents accidental repeated transformations
across authoring, handling and replay. Supporting those features requires an
explicit wire codec or native validation boundary; they are not silently supported.
This is a deliberate bounded implementation, not full Standard Schema compatibility.

## Durable boundary

Wire requests contain API ID, method, operation version, JSON input and retry policy.
The host checks all metadata against the declaration before invoking a scoped API.
It validates input before dispatch and the final middleware outcome afterward.
The guest validates replies again, including replies supplied during replay.
Object identity is used only for in-memory caching; persisted identity is explicit.
Versioning schema/implementation changes remains the author's responsibility.

`host.dispatch` returns the operation's domain Outcome. `journalHandler(host)` in
`journal-api.ts` adapts that
value to the existing journal protocol by wrapping it in an outer successful
exchange Outcome. Thus a payment decline is persisted and returned as a value;
validation defects, missing providers, and native interruption are not fabricated
as payment declines. The existing journal accepts before delivery and checks replay
request identity. Live middleware is bypassed when accepted outcomes replay.

Retry policy is pinned in the operation declaration for this scaffold. A host
cannot label an unsafe request repeatable through its binding. No new authority,
recovery algorithm, store schema or exactly-once claim is introduced.

Dynamic key enumeration requires localized assertions in the bridge; public
callers/providers/middleware have no casts. The scaffold does not model overloaded
or polymorphic method declarations, schema digests, transport authentication, or a
cross-runtime error/finalizer representation.

## Verification

Standalone experiment TypeScript compilation covers the facade, inferred providers,
middleware, authored purchase and existing-journal composition.

The existing acceptance suite now has three shared stories per runtime (six cases):

- success and decline through the payment facade/journal, completed replay without
  repeating middleware, and independent lookup success/failure through both facade
  and explicit guest views;
- SQLite close/reopen after acceptance-before-delivery, preserving the transformed
  receipt without repeating an unsafe charge or middleware;
- wrong request version rejected before provider dispatch, malformed success/failure
  after live middleware rejected before acceptance, and an invalid persisted domain
  outcome rejected by the guest before authored delivery; an in-place schema
  transformation rejected without mutating caller input.

All six focused cases passed. The mutation regression first failed, exposing a
validation bug: the original canonical JSON must be captured before invoking the
schema, since a validator can mutate its input. The binding now captures it first. Recovery uses fresh bindings and reopened SQLite in one process, with an
injected exception after acceptance; this is not a process-loss or external-payment
integration claim. Async/transform schema restrictions remain unchanged and are not
proved sufficient for every schema library. Native interruption and simultaneous
body/finalizer errors retain the earlier composition experiment's limitations.

Full repository verification is recorded in the shared research handoff.

The request and binding signatures now come from core: `ApiRequest<Wire>`,
`GuestOperations<D, Wire>`, `HostBinding<D, Y, Wire>` and `Host<Y, Wire>`. This JSON
implementation supplies Json as Wire through local aliases. The operations/host
facade is unchanged; journal call sites use `journalHandler(Api.host)` instead of
`Api.host.handle`. Wire fields and nested domain/exchange Outcome layout are unchanged.
