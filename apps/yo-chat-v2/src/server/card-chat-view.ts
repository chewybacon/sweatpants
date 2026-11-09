import { cardResult } from "../cards/contracts.ts";
import { z } from "zod";
import type { Operation } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { JournalReader } from "@sweatpan.ts/durable";
import type { ChatView, CardQuestion } from "../card-chat/contract.ts";
import { playingCard, selectionInput } from "../card-chat/contract.ts";
import { chooseCard } from "../tools/pick-card.ts";
import { cardChatProgram } from "./card-chat-program.ts";

type Reader<Y> = JournalReader<unknown, unknown, unknown, unknown, unknown, Y>;
const sample = z.object({
  ok: z.literal(true),
  value: z.object({
    response: z.object({
      message: z.object({
        content: z.array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            toolCall: z.object({ id: z.string(), name: z.string() }).optional(),
          }),
        ),
      }),
    }),
  }),
});
const accepted = z.object({ ok: z.literal(true), value: playingCard });

function* entries<Y>(reader: Reader<Y>) {
  const state = yield* reader.read();
  const result: { id: string; sequence: number; request: CapabilityRequest; value?: unknown }[] =
    [];
  for (let offset = 0; offset < state.history.end.position; ) {
    const page = yield* state.history.read(offset, 128);
    if (!page.length) {
      throw new Error("Incomplete card conversation history");
    }
    for (const entry of page) {
      result.push({
        id: entry.receipt,
        sequence: entry.sequence,
        request: entry.request as CapabilityRequest,
        value: entry.outcome.ok ? entry.outcome.value : undefined,
      });
    }
    offset = page.at(-1)!.sequence + 1;
  }
  if (state.status === "running" && state.pending) {
    result.push({
      id: state.pending.id,
      sequence: state.pending.sequence,
      request: state.pending.request as CapabilityRequest,
    });
  }
  return { state, entries: result };
}
/** Read the pinned card protocol. No Guest or provider is acquired for observation. */
export function* readCardTurn<Y>(
  root: string,
  prompt: string,
  reader: Reader<Y>,
): Operation<ChatView["turns"][number], Y> {
  const { state, entries: history } = yield* entries(reader);
  const parts: ChatView["turns"][number]["parts"] = [];
  const calls = new Map<string, Extract<(typeof parts)[number], { type: "tool" }>>();
  for (const entry of history) {
    if (entry.request.effect === `${cardChatProgram.id}/sample` && entry.value) {
      const response = sample.parse(entry.value);
      for (const [index, content] of response.value.response.message.content.entries()) {
        const id = JSON.stringify([root, entry.sequence, index]);
        if (content.type === "text" && content.text) {
          parts.push({ type: "text", id, text: content.text });
        }
        if (content.type === "tool-call" && content.toolCall) {
          const part = {
            type: "tool" as const,
            id,
            name: content.toolCall.name,
            status: "running",
            questions: [],
          };
          parts.push(part);
          calls.set(content.toolCall.id, part);
        }
      }
    }
    if (entry.request.effect === `${cardChatProgram.id}/tools`) {
      const batch = z.array(z.object({ id: z.string() })).parse(entry.request.input);
      const links = yield* reader.readChildren(entry.id);
      for (const [index, link] of links.entries()) {
        const part = calls.get(batch[index]!.id);
        if (!part) {
          throw new Error("Missing card tool call");
        }
        const child = yield* reader.openChild(link.childId);
        const detail = yield* entries(child);
        part.status = detail.state.status;
        if (detail.state.status === "completed") {
          part.result = cardResult.parse(detail.state.value).card.display;
        }
        for (const question of detail.entries) {
          if (question.request.effect !== chooseCard.id) {
            continue;
          }
          const waiting =
            detail.state.status === "running" &&
            detail.state.pending?.sequence === question.sequence &&
            detail.state.interaction?.state === "waiting";
          const answer = question.value ? accepted.parse(question.value).value : undefined;
          const item: CardQuestion = {
            id: JSON.stringify([child.id, question.sequence]),
            execution: child.id,
            root,
            input: selectionInput.parse(question.request.input),
            value: answer,
            state: answer
              ? "answered"
              : waiting
                ? "open"
                : detail.state.status === "cancelled"
                  ? "cancelled"
                  : "blocked",
            grant: waiting ? detail.state.interaction!.grant : undefined,
          };
          part.questions.push(item);
        }
      }
    }
  }
  return { execution: root, prompt, status: state.status, parts };
}
