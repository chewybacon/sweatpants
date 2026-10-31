import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { OwnedJournal } from "@sweatpan.ts/durable";
import type { Hosting } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ToolRoute } from "./contracts.ts";

/** Install one named route, without creating another routing algebra. Install parent
 * grant admission first. Reuses persisted normalized input on recovery, validates new
 * input before child creation, and leaves child-host policy/lifetime with run. */
export function* installToolRouting<
  S extends StandardSchemaV1,
  R,
  Parent,
  ParentError,
  Snapshot,
  Y,
>(
  runtime: Runtime<Y>,
  host: Hosting<Parent, CapabilityRequest, unknown, ParentError, Y>,
  journal: OwnedJournal<Parent, CapabilityRequest, unknown, ParentError, Snapshot, Y>,
  route: ToolRoute<S, R, Y, ParentError>,
): Operation<void, Y> {
  const {
    tool,
    run,
    outcome = (value: R) => ({ ok: true as const, value: { ok: true, value } }),
  } = route;
  yield* host.around({
    *child([pending], next) {
      if (pending.request.effect !== tool.id) {
        return yield* next(pending);
      }
      const snapshot = yield* journal.read();
      const links = snapshot.status === "running" ? snapshot.children : undefined;
      const existing = links?.[0];
      if (links && (links.length !== 1 || existing?.program !== tool.id)) {
        throw new Error("Stored child does not match named tool route");
      }
      let input = existing?.input;
      if (!existing) {
        const parsed = yield* runtime.fromPromise(async () =>
          tool.context["~standard"].validate(pending.request.input),
        );
        if (parsed.issues) {
          throw new Error("Invalid tool input");
        }
        input = parsed.value;
      }
      const child = yield* journal.ensureChild<R, CapabilityRequest, unknown, string>(pending.id, {
        program: tool.id,
        input,
        outcome,
      });
      return { id: child.link.childId, run: () => run(child) };
    },
  });
}
