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
