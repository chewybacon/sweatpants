import type { Channel, Operation, Task } from "effection";
import { each, spawn } from "effection";
import type { MessagePart } from "../types/chat-message.ts";
import type { ChatStateEvent } from "../state/events.ts";
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type { ChatEventTransform } from "./options.ts";
import { useBufferedChannel } from "./transforms.ts";

function composeTransforms(transforms: ChatEventTransform[]) {
  return function* (
    input: Channel<ChatStateEvent, void>,
    output: Channel<ChatStateEvent, void>,
  ): Operation<void> {
    if (transforms.length === 0) {
      for (const event of yield* each(input)) {
        yield* output.send(event);
        yield* each.next();
      }
      return;
    }

    let current = input;
    const tasks: Task<void>[] = [];
    for (let index = 0; index < transforms.length; index++) {
      const transform = transforms[index]!;
      const last = index === transforms.length - 1;
      const next = last ? output : yield* useBufferedChannel<ChatStateEvent>();
      const source = current;
      const destination = next;
      tasks.push(
        yield* spawn(function* () {
          yield* transform(source, destination);
          if (!last) {
            yield* destination.close();
          }
        }),
      );
      current = next;
    }
    for (const task of tasks) {
      yield* task;
    }
  };
}

/** Render one hydrated assistant message through the same event transforms used live. */
export function* renderReplayMessageParts(
  messageId: string,
  content: string,
  transforms: ChatEventTransform[] | undefined,
): Operation<MessagePart[] | undefined> {
  if (!content) {
    return undefined;
  }
  if (!transforms?.length) {
    return [{ id: `${messageId}:text`, type: "text", content, rendered: content }];
  }

  const input = yield* useBufferedChannel<ChatStateEvent>();
  const output = yield* useBufferedChannel<ChatStateEvent>();
  const runTransforms = composeTransforms(transforms);
  let state = initialChatState;

  const transformTask = yield* spawn(function* () {
    yield* runTransforms(input, output);
    yield* output.close();
  });
  const collectTask = yield* spawn(function* () {
    for (const event of yield* each(output)) {
      state = chatReducer(state, event);
      yield* each.next();
    }
  });

  const correlation = { threadId: "replay", runId: `replay:${messageId}` };
  yield* input.send({ type: "RUN_STARTED", ...correlation });
  yield* input.send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
  yield* input.send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: content });
  yield* input.send({ type: "TEXT_MESSAGE_END", messageId });
  yield* input.send({ type: "RUN_FINISHED", ...correlation, outcome: { type: "success" } });
  yield* input.close();
  yield* transformTask;
  yield* collectTask;

  return state.finalizedParts[messageId];
}
