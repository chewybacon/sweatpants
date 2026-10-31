import type { Composition, Operation } from "@standard-durability/core";
import { createModelProvider } from "@sweatpan.ts/providers";
import { createProgramResolver, type ProgramInvocation } from "@sweatpan.ts/execution";
import { createElicitationHandler, createResponseSubscriptions } from "@sweatpan.ts/chat-client";
import type { Stream } from "@sweatpan.ts/runtime";

/** Public consumers are checked against both source and emitted declarations. */
export function capabilityTypes<Y>(
  composition: Composition<Y>,
  stream: (request: { prompt: string }) => Stream<number, boolean, Y>,
) {
  const provider = createModelProvider(composition, "model", { stream });
  const reader: Stream<number, boolean, Y> = provider.operations.stream({ prompt: "hello" });
  // @ts-expect-error Request inference must not widen to unknown.
  provider.operations.stream({ prompt: 1 });
  const resolver = createProgramResolver(composition, "program", {
    *resolve(input: ProgramInvocation<{ source: string }>) {
      return { source: input.input.source };
    },
  });
  const resolved: Operation<{ source: string }, Y> = resolver.operations.resolve({
    program: "pinned",
    input: { source: "code" },
  });
  // @ts-expect-error Resolver input stays correlated with its driver.
  resolver.operations.resolve({ program: "pinned", input: { source: false } });
  const responses = createResponseSubscriptions(composition, "responses", {
    subscribe(cursor: number) {
      return stream({ prompt: String(cursor) });
    },
  });
  const output: Stream<number, boolean, Y> = responses.operations.subscribe(0);
  // @ts-expect-error Cursor type remains number.
  responses.operations.subscribe("0");
  const handler = createElicitationHandler(composition, "handler", {
    *handle(question: string) {
      return { ok: true as const, value: question.length };
    },
  });
  // @ts-expect-error Handler context remains string.
  handler.operations.handle(1);
  return { reader, resolved, output, handler };
}
