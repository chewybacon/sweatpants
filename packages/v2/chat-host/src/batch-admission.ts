import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ChildLink } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import { defineTool } from "@sweatpan.ts/tools";
import type {
  ChatRecoveryFactory,
  ChatToolBinding,
  ChatToolBindingOptions,
  ChatToolRejection,
} from "./contracts.ts";
import { createChatToolBinding } from "./tool-binding.ts";

interface RejectedInput {
  readonly target: string | null;
  readonly value: unknown;
}

function isRejectedInput(input: unknown): input is RejectedInput {
  return (
    typeof input === "object" &&
    input !== null &&
    "target" in input &&
    (input.target === null || typeof input.target === "string") &&
    "value" in input
  );
}

const rejectedInput: StandardSchemaV1<unknown, RejectedInput> = {
  "~standard": {
    version: 1,
    vendor: "sweatpan.ts/chat-host",
    validate(input) {
      return isRejectedInput(input)
        ? { value: input }
        : { issues: [{ message: "Invalid recorded tool rejection" }] };
    },
  },
};

/** An ordinary owned child retains the admission decision even if a sibling parks.
 * Its program is reserved only in hosts that enable rejection; it has no grants. */
export function createRejectionBinding<Y>(
  runtime: Runtime<Y>,
  program: string,
  recovery: ChatRecoveryFactory<Y>,
  matches: ChatToolBindingOptions<unknown, Y>["matches"],
) {
  const tool = defineTool(program + "/rejected-tool")
    .parameters(rejectedInput)
    .execute(function* (input) {
      return input.value;
    });
  return createChatToolBinding(runtime, tool, {
    definition: { name: "rejected-tool", description: "Internal rejection", parameters: {} },
    recovery,
    matches,
  });
}

export function* admitCall<Y>(
  runtime: Runtime<Y>,
  call: { readonly name: string; readonly input: unknown },
  tool: ChatToolBinding<Y> | undefined,
  stored: ChildLink | undefined,
  fallback: ChatToolBinding<Y> | undefined,
  reject: ((error: ChatToolRejection) => unknown) | undefined,
) {
  const target = tool?.program ?? null;
  if (stored) {
    if (tool && stored.program === tool.program) {
      return { binding: tool, input: stored.input };
    }
    if (
      fallback &&
      stored.program === fallback.program &&
      isRejectedInput(stored.input) &&
      stored.input.target === target
    ) {
      return { binding: fallback, input: stored.input };
    }
    throw new Error("Stored chat batch differs from catalog");
  }
  let rejection: ChatToolRejection;
  if (tool) {
    const parsed = yield* runtime.fromPromise(async () =>
      tool.context["~standard"].validate(call.input),
    );
    if (!parsed.issues) {
      return { binding: tool, input: parsed.value };
    }
    rejection = { reason: "invalid-input", name: call.name, issues: parsed.issues };
  } else {
    rejection = { reason: "unknown-tool", name: call.name };
  }
  if (!fallback || !reject) {
    throw new Error(tool ? "Invalid chat tool input" : "Unknown model tool");
  }
  return { binding: fallback, input: { target, value: reject(rejection) } };
}
