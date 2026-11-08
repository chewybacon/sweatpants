# @sweatpants/standard-durability-effection

Private experimental implementation of the portable composition contract using
Effection's native APIs, contexts, scopes and cleanup. Exports `effection` and
`EffectionYield`. Requires an Effection 4.2-compatible peer runtime. The portable
core never depends on this adapter. Uses Effection's experimental createApi API.

```ts
import { effection } from "@sweatpants/standard-durability-effection";
```

This composition adapter is distinct from `@sweatpants/runtime-effection`, which
implements the existing execution capability interface. No second scheduler exists.
