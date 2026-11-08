import { chooseFlight } from "../../examples/flight-chat.ts";
import { defineElicitPlugin, defineElicitPlugins, createElicitResponder } from "@sweatpan.ts/tools";

const registration = defineElicitPlugin(chooseFlight);
export const seatPlugin = registration.onElicit({
  *pickSeat({ context: input }) {
    const seats: string[] = input.seats;
    // @ts-expect-error Seat context is not flight search context.
    void input.airline;
    return { ok: true, value: seats.includes("2A") ? "2A" : "2B" };
  },
});
export const wrongAnswer = registration.onElicit({
  // @ts-expect-error Flight replies cannot answer a seat elicit.
  *pickSeat() {
    return { ok: true, value: "flight-1" };
  },
});
export const wrongName = registration.onElicit({
  // @ts-expect-error Only the tool's declared elicits can be registered.
  *approvePayment() {
    return { ok: true, value: "2A" };
  },
});

// Yield requirements come from the handler, not an explicit registration generic.
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Operation, Outcome } from "@standard-durability/core";
import type { ToolInteraction } from "@sweatpan.ts/tools";
import type { ElicitSelection } from "@sweatpan.ts/tools";

export function inferredHandlerRuntime<Y>(
  runtime: Runtime<Y>,
  selection: ElicitSelection,
  question: ToolInteraction,
) {
  const plugin = registration.onElicit({
    *pickSeat() {
      const seat = yield* runtime.fromPromise(async () => "2A" as const);
      return { ok: true, value: seat };
    },
  });
  const response: Operation<Outcome<unknown, unknown>, Y> = createElicitResponder(
    runtime,
    "typed",
    plugin,
    () => ({}),
  ).operations.respond(selection, question);
  const portable: Operation<Outcome<unknown, unknown>, Y> = createElicitResponder(
    runtime,
    "portable",
    seatPlugin,
    () => ({}),
  ).operations.respond(selection, question);
  // @ts-expect-error Runtime requirements must not be erased by registration.
  const withoutRuntime: Operation<Outcome<unknown, unknown>, never> = response;
  void withoutRuntime;
  return { response, portable };
}

import { createReactElicitHost } from "@sweatpan.tsx/chat";
import { SeatPicker } from "../../examples/chat-prototype/react-elicit.tsx";

export function reactHandlerTypes<Y>(runtime: Runtime<Y>) {
  const host = createReactElicitHost(runtime);
  const registration = host.definePlugin(chooseFlight);
  const valid = registration.onElicit({
    *pickSeat(args, ctx) {
      const key: "pickSeat" = ctx.interaction.key;
      void key;
      // @ts-expect-error The adapter supplies this immutable correlation data.
      ctx.interaction.execution = "another-execution";
      // @ts-expect-error SeatPicker requires its flight prop.
      yield* ctx.render(SeatPicker, { seats: args.context.seats });
      const value = yield* ctx.render(SeatPicker, args.context);
      const seat: "2A" | "2B" = value;
      return { ok: true, value: seat };
    },
  });
  function WrongPicker(_props: { onRespond: (value: "flight-1") => void }) {
    return null;
  }
  const invalid = registration.onElicit({
    // @ts-expect-error A component returning a flight ID cannot answer a seat elicit.
    *pickSeat(_args, ctx) {
      const value = yield* ctx.render(WrongPicker, {});
      return { ok: true, value };
    },
  });
  return { valid, invalid };
}

// Declaration can be shared by independent sessions; no host instance is captured.
const declarePromptPlugin = defineElicitPlugins<{ choose(): Operation<"2A", never> }>();
export const reusablePlugin = declarePromptPlugin(chooseFlight).onElicit({
  *pickSeat(_args, ctx) {
    return { ok: true, value: yield* ctx.choose() };
  },
});

// @ts-expect-error Plugin authors do not supply a separate compatibility revision.
defineElicitPlugin(chooseFlight, "obsolete-revision");
