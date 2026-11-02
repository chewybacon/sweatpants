# @sweatpants/standard-durability-effect

Private experimental implementation of the portable composition contract using
Effect's native resource scopes and binding frames. Requires an Effect 4.0.6-compatible
peer runtime. Exports `effect`, `effectProgram`, `execute`, `EffectYield` and the frame
service. Core never imports or depends on this adapter.

```ts
import { Effect } from "effect";
import { effect, effectProgram } from "@sweatpants/standard-durability-effect";

// effectProgram supplies the root binding frame and resource lifetime.
// Effect.runPromise(effectProgram(work));
```

This is the extracted experiment, preserving its documented limits: explicit scoped
composition for isolated bindings, native error channels, and no general inference
of additional Effect services. See experiments/standard-durability/effect-adapter.md.
It complements the existing runtime-effect execution adapter; it does not wrap
Effection or implement another scheduler.
