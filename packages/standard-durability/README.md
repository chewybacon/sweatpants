# @sweatpants/standard-durability

Private, experimental contract scaffold. Not a published standard.

Portable `Operation`, `Work`, `Outcome`, API/context/composition signatures, and
Standard Schema-backed API declarations (`defineApi`, `operation`), and generic
request/binding signatures (`ApiRequest<Wire>`, `GuestOperations`, `HostBinding`, `Host`). This package
has no runtime scheduler, storage engine, JSON policy, provider, or adapter imports.
Its only production dependency is `@standard-schema/spec`, imported as a type.
The emitted JavaScript contains declaration constructors only, with no imports.
It compiles with ES2022 and no ambient Node or DOM types.

```ts
import { defineApi, operation, type Composition } from "@sweatpants/standard-durability";
```

Native adapters are separate packages:

- `@sweatpants/standard-durability-effection`
- `@sweatpants/standard-durability-effect`

Consumers choose an adapter explicitly. Core does not re-export adapters and has
no optional runtime peers. Foundation re-exports the shared computation types so
existing Sweatpants code retains one canonical operation/outcome definition.

The current JSON wire binding lives in `experiments/standard-durability/api-bindings.ts`.
It uses Sweatpants foundation and therefore is deliberately outside this dependency
boundary. Model schemas, chat composition and native providers are also application
integrations, not part of this contract package. Extraction of those policies into
portable packages is a separate decision; this scaffold does not call them portable
merely because their imports are type-safe.

`Wire` is deliberately unconstrained: these types neither admit nor encode values.
The concrete binding chooses validation and representation. Host dispatch returns
a domain Outcome and owns no journal acceptance. The experimental journal adapter
in `journal-api.ts` adds the existing outer exchange Outcome separately.
