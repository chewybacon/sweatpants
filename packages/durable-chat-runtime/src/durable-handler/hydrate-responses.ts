import { EventType } from "@ag-ui/core";
import { resource, type Operation, type Stream, type Subscription } from "effection";
import {
  ConversationSegmentValidator,
  type ConversationWindowFrame,
  type ConversationStreamEvent,
} from "@sweatpants/chat-core";
import { ConversationStoreApi } from "@sweatpants/history-store/port";
import type { ConversationHead } from "@sweatpants/history-store/contract";
import { conversationAuthorityFrame } from "../conversation-authority.ts";

interface HydrateResponse {
  subscription: Subscription<string, void>;
  cleanup?: () => Operation<void>;
}

function* directEventStream(
  events: readonly ConversationStreamEvent[],
): Operation<Subscription<string, void>> {
  const stream: Stream<string, void> = resource(function* (provide) {
    let index = 0;
    const validator = new ConversationSegmentValidator();
    let finished = false;
    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (index >= events.length) {
          if (!finished) {
            validator.finish();
          }
          return { done: true, value: undefined };
        }
        const event = events[index++]!;
        validator.push(event);
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
          validator.finish();
          finished = true;
        }
        return { done: false, value: JSON.stringify(event) };
      },
    });
  });
  return yield* stream;
}

/** A pre-admission rejection has no fabricated run and ends at RUN_ERROR. */
export function* createConversationCommandErrorResponse(params: {
  conversationId: string;
  code: string;
  message: string;
}): Operation<HydrateResponse> {
  const head = yield* ConversationStoreApi.operations.loadHead(params.conversationId);
  return {
    subscription: yield* directEventStream([
      conversationAuthorityFrame(params.conversationId, head),
      {
        type: EventType.RUN_ERROR,
        code: params.code,
        message: params.message,
      },
    ]),
  };
}

/** Native hydration is exactly one bounded window followed by public authority. */
export function* createStoredConversationCheckpointResponse(params: {
  conversationId: string;
  head: ConversationHead;
  window: ConversationWindowFrame;
}): Operation<HydrateResponse> {
  return {
    subscription: yield* directEventStream([
      params.window,
      conversationAuthorityFrame(params.conversationId, params.head),
    ]),
  };
}
