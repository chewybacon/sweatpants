import { inProcess } from "@sweatpants/agent-host/server";
import { activateJournal, type PendingJournal } from "@sweatpants/primitive-journal";
import { assertJson } from "@sweatpants/foundation";
import { success } from "@sweatpants/foundation/computation";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Composition, Operations } from "@sweatpants/standard-durability";
import { type JournalRequest } from "../../packages/agent-sdk/src/index.ts";
import { bookFlightTool } from "../../apps/yo-chat/src/tools/book-flight/tool.ts";

type Request<K extends JournalRequest["kind"]> = Extract<JournalRequest, { kind: K }>;

/** Host-facing requests retain tool/call identity and schema validation in the context. */
export interface ToolCapabilities {
  sample(request: Request<"nested-sample">): { text: string };
  elicit(request: Request<"elicit">): unknown;
  effect(request: Request<"effect">): unknown;
  log(request: Request<"log">): void;
  notify(request: Request<"progress">): void;
}

/** One scoped API supplies the capabilities projected into the existing authored context. */
export function createToolContext<Y>(composition: Composition<Y>) {
  function* missing(): Generator<Y, never, unknown> {
    throw new Error("Tool capability not installed");
  }
  const Capabilities = composition.createApi<ToolCapabilities>("tool-capabilities", {
    sample: missing,
    elicit: missing,
    effect: missing,
    log: missing,
    notify: missing,
  });
  const operations = Capabilities.operations;
  function dispatch(request: JournalRequest) {
    switch (request.kind) {
      case "nested-sample":
        return operations.sample(request);
      case "elicit":
        return operations.elicit(request);
      case "effect":
        return operations.effect(request);
      case "log":
        return operations.log(request);
      case "progress":
        return operations.notify(request);
    }
  }
  return {
    Capabilities,
    dispatch,
  };
}

/** Run the actual yo-chat tool body using caller-installed capabilities. */
export function bookFlightWithCapabilities<Y>(
  composition: Composition<Y>,
  capabilities: Operations<ToolCapabilities, Y>,
  input: StandardSchemaV1.InferInput<typeof bookFlightTool.parameters>,
  callId: string,
  journal: PendingJournal,
) {
  const tool = createToolContext(composition);
  return composition.scoped(function* () {
    yield* tool.Capabilities.install(capabilities);
    return yield* activateJournal(
      inProcess().prepare(bookFlightTool, "book-flight").guest(input, callId),
      journal,
      {
        classify: (request) =>
          request.kind === "effect" ? request.retrySafety.mode : "repeatable",
        *handler(request) {
          return success(assertJson((yield* tool.dispatch(request)) ?? null));
        },
      },
    );
  });
}
