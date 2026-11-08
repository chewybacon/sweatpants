import type { QuestionContract, QuestionAnswer } from "@sweatpan.ts/chat-client";
import { z } from "zod";
import type { Operation, Outcome } from "@standard-durability/core";
import {
  materializeConversation,
  type ConversationPart,
  type ConversationNode,
} from "@sweatpan.ts/chat-client";
import type { JournalReader } from "@sweatpan.ts/durable";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ResolutionGrant } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import { fileConversationProgram } from "./file-chat.ts";
import type { createFileConversation } from "./file-conversation.ts";

export type FileQuestionContext = {
  readonly path: string;
  readonly step: "read" | "confirm" | "repair";
};
export interface FileQuestionContract extends QuestionContract {
  readonly kind: "file";
  readonly context: FileQuestionContext;
  readonly response: string;
}
export type ConversationMessage = Extract<
  ConversationPart<FileQuestionContract>,
  { type: "message" }
>;
export interface ConversationQuestion {
  readonly id: string;
  readonly root: string;
  readonly execution: string;
  readonly grant: ResolutionGrant;
  readonly context: FileQuestionContract["context"];
}
export interface ConversationView {
  readonly conversation: string;
  readonly turns: readonly {
    readonly execution: string;
    readonly ordinal: number;
    readonly status: "reserved" | "running" | "completed" | "cancelled";
    readonly revision: number;
    readonly messages: readonly ConversationMessage[];
  }[];
  readonly questions: readonly ConversationQuestion[];
}
export interface ConversationAnswer {
  readonly root: string;
  readonly execution: string;
  readonly grant: ResolutionGrant;
  readonly text: QuestionAnswer<FileQuestionContract, never>["value"];
}
export interface ConversationAnswerReceipt {
  readonly receipt: string;
  readonly duplicate: boolean;
}

// Decode only the pinned application's recorded-chat/v1 sample envelope. This is
// display policy, not a general public model codec. Never publish reasoning, model
// request history, arbitrary tool arguments, executable declarations or raw failures.
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
const context = z.object({ path: z.string(), step: z.enum(["read", "confirm", "repair"]) });

/** Caller has authorized this conversation. Observation reads a finite catalog and
 * per-root accepted prefixes, then discovers questions through separate snapshots.
 * It never drives execution; no atomic whole-tree view or pagination is promised. */
export function createFileConversationView<Y>(
  runtime: Runtime<Y>,
  id: string,
  conversation: ReturnType<typeof createFileConversation<Y>>,
) {
  return {
    observe() {
      return runtime.composition.scoped(function* () {
        const turns: ConversationView["turns"][number][] = [];
        const questions: ConversationQuestion[] = [];
        const catalog = conversation.turns();
        for (const row of catalog) {
          const reader = conversation.reader(row.execution);
          const state = yield* reader.read();
          const nodes: ConversationNode<FileQuestionContract>[] = [];
          const userId = JSON.stringify([row.execution, "user"]);
          nodes.push({ type: "message", id: userId, parentId: null, order: 0, role: "user" });
          nodes.push({
            type: "text",
            id: `${userId}:text`,
            parentId: userId,
            order: 0,
            text: row.prompt,
          });
          function* collect(
            source: JournalReader<unknown, unknown, unknown, unknown, unknown, Y>,
            parentId: string | null,
          ): Operation<void, Y> {
            const snapshot = yield* source.read();
            const history = [];
            for (let offset = 0; offset < snapshot.history.end.position; ) {
              const page = yield* snapshot.history.read(offset, 128);
              if (!page.length) {
                throw new Error("Incomplete accepted conversation prefix");
              }
              history.push(...page);
              offset = page.at(-1)!.sequence + 1;
            }
            const entries: {
              id: string;
              sequence: number;
              request: CapabilityRequest;
              outcome?: Outcome<unknown, unknown>;
            }[] = history.map((entry) => ({
              id: entry.receipt,
              sequence: entry.sequence,
              request: entry.request as CapabilityRequest,
              outcome: entry.outcome,
            }));
            if (snapshot.status === "running" && snapshot.pending) {
              entries.push({
                id: snapshot.pending.id,
                sequence: snapshot.pending.sequence,
                request: snapshot.pending.request as CapabilityRequest,
                outcome: undefined,
              });
            }
            const calls = new Map<
              string,
              Extract<ConversationNode<FileQuestionContract>, { type: "tool-call" }>
            >();
            for (const entry of entries) {
              const id = JSON.stringify([source.id, entry.id]);
              const order = entry.sequence + 1;
              if (
                entry.request.effect === `${fileConversationProgram}/sample` &&
                entry.outcome?.ok
              ) {
                const content = sample.parse(entry.outcome.value).value.response.message.content;
                calls.clear();
                nodes.push({ type: "message", id, parentId, order, role: "assistant" });
                for (const [index, part] of content.entries()) {
                  if (part.type === "text") {
                    nodes.push({
                      type: "text",
                      id: `${id}:${index}`,
                      parentId: id,
                      order: index,
                      text: part.text ?? "",
                    });
                  } else if (part.type === "tool-call" && part.toolCall) {
                    const node = {
                      type: "tool-call" as const,
                      id: `${id}:${index}`,
                      parentId: id,
                      order: index,
                      callId: part.toolCall.id,
                      name: part.toolCall.name,
                      state: "pending" as const,
                    };
                    nodes.push(node);
                    calls.set(part.toolCall.id, node);
                  }
                }
              } else if (entry.request.effect === `${fileConversationProgram}/tools`) {
                const batch = z
                  .array(z.object({ id: z.string(), name: z.string() }))
                  .parse(entry.request.input);
                const links = yield* source.readChildren(entry.id);
                if (links.length !== 0 && links.length !== batch.length) {
                  throw new Error("Incomplete conversation child placement");
                }
                for (const [index, link] of links.entries()) {
                  const call = batch[index]!;
                  const node = calls.get(call.id);
                  if (!node || node.name !== call.name) {
                    throw new Error("Missing conversation tool parent");
                  }
                  const child = yield* source.openChild(link.childId);
                  const childState = yield* child.read();
                  const replacement = {
                    ...node,
                    state: childState.status,
                    output:
                      childState.status === "completed"
                        ? z.string().parse(childState.value)
                        : undefined,
                  };
                  nodes[nodes.indexOf(node)] = replacement;
                  yield* collect(child, node.id);
                }
              } else if (entry.request.effect === "file-chat.answer-v1") {
                const question = context.parse(entry.request.input);
                const response = entry.outcome?.ok
                  ? z
                      .object({ ok: z.literal(true), value: z.string() })
                      .safeParse(entry.outcome.value)
                  : undefined;
                const placement = {
                  type: "question" as const,
                  kind: "file" as const,
                  id,
                  parentId,
                  order,
                  question,
                };
                if (response?.success) {
                  nodes.push({ ...placement, state: "answered", response: response.data.value });
                } else if (entry.outcome) {
                  throw new Error("Unsupported file answer outcome");
                } else {
                  nodes.push({
                    ...placement,
                    state: snapshot.interaction?.state === "invalidated" ? "cancelled" : "pending",
                  });
                }
              } else if (entry.request.effect === "file-review.sample-v1" && entry.outcome?.ok) {
                const result = z
                  .object({ ok: z.literal(true), value: z.object({ text: z.string() }) })
                  .parse(entry.outcome.value);
                nodes.push({ type: "message", id, parentId, order, role: "assistant" });
                nodes.push({
                  type: "text",
                  id: `${id}:text`,
                  parentId: id,
                  order: 0,
                  text: result.value.text,
                });
              }
            }
          }
          yield* collect(reader, null);
          const roots = materializeConversation<FileQuestionContract>(nodes);
          const messages = roots.map((part) => {
            if (part.type !== "message") {
              throw new Error("Conversation root is not a message");
            }
            return part;
          });
          turns.push({
            execution: row.execution,
            ordinal: row.ordinal,
            status: state.admission ? state.status : "reserved",
            revision: state.revision,
            messages,
          });
          if (!state.admission || state.status !== "running") {
            continue;
          }
          const stream = yield* conversation.turn(row.execution).interactions();
          while (true) {
            const next = yield* stream.next();
            if (next.done) {
              break;
            }
            const question = next.value;
            if (question.declaration.id !== "file-chat.answer-v1") {
              throw new Error("Unsupported conversation question");
            }
            questions.push({
              id: JSON.stringify([question.execution, question.grant.requestId]),
              root: row.execution,
              execution: question.execution,
              grant: { ...question.grant },
              context: context.parse(question.input),
            });
          }
        }
        return { conversation: id, turns, questions } satisfies ConversationView;
      });
    },
    *answer(command: ConversationAnswer) {
      // Root enrollment and descendant ownership are verified by the existing
      // conversation/chat assembly; a displayed grant is not an authorization token.
      const accepted = yield* conversation
        .turn(command.root)
        .answer(
          { execution: command.execution, grant: command.grant },
          { ok: true, value: command.text },
        );
      return {
        receipt: accepted.entry.receipt,
        duplicate: accepted.duplicate,
      } satisfies ConversationAnswerReceipt;
    },
  };
}
