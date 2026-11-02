// Only stack assembly imports native runtimes and concrete adapters.
import { Effect } from "effect";
import { call, useAbortSignal } from "effection";
import { createRuntime as createEffectRuntime } from "@sweatpan.ts/runtime-effect";
import type { EffectRuntime } from "@sweatpan.ts/runtime-effect";
import { createRuntime as createEffectionRuntime } from "@sweatpan.ts/runtime-effection";
import type { EffectionRuntime } from "@sweatpan.ts/runtime-effection";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ProtocolReply, ProtocolRig } from "@sweatpan.ts/testing";
import type { ReadOutcome, Repository, RepositoryOperations } from "./application.ts";

function outcome(reply: ProtocolReply): ReadOutcome {
  return reply.status === 200
    ? { ok: true, value: { body: reply.body } }
    : { ok: false, error: { status: reply.status } };
}

export function forEachRuntime(
  suite: <Y>(runtime: Runtime<Y>, client: (rig: ProtocolRig) => RepositoryOperations<Y>) => void,
) {
  suite(
    createEffectRuntime(),
    (rig) =>
      ({
        read: (id, token) =>
          Effect.map(
            Effect.promise((signal) => rig.send({ id, token }, signal)),
            outcome,
          ),
      }) satisfies Repository<EffectRuntime>,
  );
  suite(
    createEffectionRuntime(),
    (rig) =>
      ({
        *read(id, token) {
          const signal = yield* useAbortSignal();
          return outcome(yield* call(() => rig.send({ id, token }, signal)));
        },
      }) satisfies Repository<EffectionRuntime>,
  );
}
