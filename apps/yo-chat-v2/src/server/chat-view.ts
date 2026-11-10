import type { ChatDemo } from "./chat-demo.ts";
import { z } from "zod";
import type { Operation } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { JournalReader } from "@sweatpan.ts/durable";
import type { ChatView, ChatQuestion } from "../chat/contract.ts";

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
const accepted = z.object({ ok: z.literal(true), value: z.unknown() });

function* entries<Y>(reader: Reader<Y>) {
  const state = yield* reader.read();
  const result: { id: string; sequence: number; request: CapabilityRequest; value?: unknown }[] =
    [];
  for (let offset = 0; offset < state.history.end.position; ) {
    const page = yield* state.history.read(offset, 128);
    if (!page.length) {
      throw new Error("Incomplete conversation history");
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
/** Read the demo’s pinned recorded-chat protocol. No Guest or provider is acquired for observation. */
export function* readDemoTurn<Y>(
  demo: ChatDemo,
  root: string,
  prompt: string,
  reader: Reader<Y>,
): Operation<ChatView["turns"][number], Y> {
  const { state, entries: history } = yield* entries(reader);
  if (state.program !== demo.program.id) {
    throw new Error("Wrong chat program");
  }
  const parts: ChatView["turns"][number]["parts"] = [];
  const calls = new Map<string, Extract<(typeof parts)[number], { type: "tool" }>>();
  for (const entry of history) {
    if (entry.request.effect === `${demo.program.id}/sample` && entry.value) {
      const response = sample.parse(entry.value);
      for (const [index, content] of response.value.response.message.content.entries()) {
        const id = JSON.stringify([root, entry.id, index]);
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
    if (entry.request.effect === `${demo.program.id}/tools`) {
      const batch = z.array(z.object({ id: z.string() })).parse(entry.request.input);
      const links = yield* reader.readChildren(entry.id);
      if (links.length && links.length !== batch.length) {
        throw new Error("Tool batch cardinality mismatch");
      }
      for (const [index, link] of links.entries()) {
        const part = calls.get(batch[index]!.id);
        if (!part) {
          throw new Error("Missing recorded tool call");
        }
        const contract = demo.tools.find((tool) => tool.id === link.program);
        if (!contract) {
          throw new Error("Missing tool declaration");
        }
        const child = yield* reader.openChild(link.childId);
        const detail = yield* entries(child);
        part.status = detail.state.status;
        if (detail.state.status === "completed") {
          part.result = demo.formatResult(detail.state.value);
        }
        for (const question of detail.entries) {
          if (
            !Object.values(contract.elicits).some((effect) => effect.id === question.request.effect)
          ) {
            continue;
          }
          const waiting =
            detail.state.status === "running" &&
            detail.state.pending?.id === question.id &&
            detail.state.interaction?.state === "waiting";
          const answer = question.value ? accepted.parse(question.value).value : undefined;
          const item: ChatQuestion = {
            id: JSON.stringify([child.id, question.id]),
            execution: child.id,
            root,
            program: link.program,
            effect: question.request.effect,
            input: demo.decodeInput(question.request.effect, question.request.input),
            value: answer,
            state:
              question.value !== undefined
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
