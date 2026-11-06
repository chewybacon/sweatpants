import { assertUniqueElicitIds } from "./elicit-support.ts";
import type { ElicitSelection } from "./contracts.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome } from "@standard-durability/core";
import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type { OwnedJournal } from "@sweatpan.ts/durable";
import type { EffectCapabilities, Hosting } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ElicitHandlers, ToolRoute } from "./contracts.ts";

/**
 * Install scoped delivery policy for every declared elicitation. Supplied handlers
 * execute with normalized request context and return raw authored Outcomes through
 * existing effect delivery/response validation. Omitted handlers park through the
 * host's participant registration; use installEffectAnswers to submit later answers.
 * Unrelated effects delegate to surrounding middleware. Inner installations replace
 * policy for this tool's entire elicitation set and disappear on scope exit. Routing
 * uses min middleware, so ordinary outer middleware can wrap or bypass this policy.
 * Installation grants no authority, acquires no Guest, and sends no presentation
 * event; callers must install grant admission and participant storage separately.
 * Handler middleware remains available through effects.api(definition).around.
 */
export function* installElicitHandlers<L extends Record<string, EffectDefinition>, R, E, Y>(
  host: Hosting<R, CapabilityRequest, unknown, E, Y>,
  effects: EffectCapabilities<Y>,
  tool: { readonly elicits: L },
  handlers: ElicitHandlers<NoInfer<L>, Y> = {},
): Operation<void, Y> {
  const modes = new Map<string, "execute" | "wait">();
  for (const key of Object.keys(tool.elicits)) {
    const definition = tool.elicits[key];
    // Register identity even for participant routing, rejecting conflicting definitions.
    effects.api(definition);
    const handler = Object.hasOwn(handlers, key) ? handlers[key as keyof L] : undefined;
    if (handler) {
      // Iteration erases the per-key correlation only here; each handler is installed
      // against the same definition from which its public signature was inferred.
      yield* effects.install(
        definition,
        handler as (context: unknown) => Operation<Outcome<unknown, unknown>, Y>,
      );
    }
    modes.set(definition.id, handler ? "execute" : "wait");
  }
  yield* host.around(
    {
      *deliveryMode([request], next) {
        return modes.get(request.effect) ?? (yield* next(request));
      },
    },
    { at: "min" },
  );
}

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

/** Apply a retained selection through existing elicit delivery middleware.
 * Validate all routes and server implementations before installing anything. Client
 * routes park even when an unselected server implementation is available. The caller
 * owns authorization, admission-time persistence and program resolution. */
export function* installSelectedElicitHandlers<L extends Record<string, EffectDefinition>, R, E, Y>(
  host: Hosting<R, CapabilityRequest, unknown, E, Y>,
  effects: EffectCapabilities<Y>,
  tool: { readonly id: string; readonly elicits: L },
  selection: ElicitSelection,
  handlers: ElicitHandlers<NoInfer<L>, Y> = {},
): Operation<void, Y> {
  assertUniqueElicitIds(tool.elicits);
  if (
    selection.tool !== tool.id ||
    Object.keys(selection.routes).some((key) => !Object.hasOwn(tool.elicits, key))
  ) {
    throw new Error("Incompatible retained elicit selection");
  }
  const selected: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(tool.elicits)) {
    const route = Object.hasOwn(selection.routes, key) ? selection.routes[key] : undefined;
    if (route !== "client" && route !== "server") {
      throw new Error(`Missing elicit route: ${key}`);
    }
    if (route === "server") {
      const handler = Object.hasOwn(handlers, key) ? handlers[key] : undefined;
      if (typeof handler !== "function") {
        throw new Error(`Missing selected server handler: ${key}`);
      }
      selected[key] = handler;
    }
  }
  // Each selected entry is the original typed handler under its unchanged alias.
  yield* installElicitHandlers(host, effects, tool, selected as ElicitHandlers<L, Y>);
}
