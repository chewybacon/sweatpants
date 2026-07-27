# Execution store seam: four styles

Unstaged spike. Same contract, same tests, four shapes. Run with:

```bash
pnpm --filter @sweatpants/journal-authority test -- styles
```

|                                    | A: api as port                     | B: derived facade        | C: explicit facade (shipped)     | D: typed port   |
| ---------------------------------- | ---------------------------------- | ------------------------ | -------------------------------- | --------------- |
| Declarations per operation         | 1                                  | 2 (interface + key list) | 3 (interface + facade + adapter) | 1               |
| Typed generic seam                 | n/a                                | `createDriverApi<T>`     | n/a                              | `definePort<T>` |
| Adapter shape                      | middleware                         | plain object             | plain object                     | plain object    |
| Direct adapter conformance         | no                                 | yes                      | yes                              | yes             |
| Context exported / seam bypassable | no                                 | yes                      | yes                              | no              |
| Middleware order sensitivity       | none once driver installs at `min` | none                     | none                             | none            |
| Fail-closed with nothing installed | yes                                | yes                      | yes                              | yes             |
| Teachability                       | medium                             | medium                   | highest                          | high            |

## Ordering, corrected

`api-internal.js` builds the stack as `combine(max.concat(min))` with `around` defaulting to `at: "max"`. A terminal driver installed at the default therefore sits outside later middleware and makes it unreachable. Drivers must install at `min`; policy and observation middleware use the default `max`.

Both orderings are now asserted for every style:

- `supports observation middleware installed after the driver`
- `supports observation middleware installed before the driver`

## Style D

`definePort(name, portDeclaration)` uses the declaration as three things at once: the contract type, the runtime key list, and the fail-closed default. `installDriver(plainObject)` adapts an ordinary adapter into terminal middleware at `min`.

That keeps:

- A's non-bypassable seam, because no Context is exported and there is no `useStore()` accessor;
- B's typing, because everything derives from one generic declaration;
- C's plain adapters and readable call sites, because drivers are ordinary objects and callers write `StoreApi.operations.load(id)`.

Remaining cost: the port declaration bodies are stubs that only call `unavailable()`, which is mild ceremony, and `installDriver` needs one `SAFETY` cast internally.

## Recommendation

D for `ExecutionStore` and the tool-session store, with C's explicitness preserved at the call site. If third-party driver authors ever need to see an interface rather than infer it, export `type ExecutionStore = ...` derived from the port, as shown in `style-d-typed-port.ts`.
