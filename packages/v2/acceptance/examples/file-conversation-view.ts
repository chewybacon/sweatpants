import { z } from "zod";
import type { ResolutionGrant } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import { fileConversationProgram } from "./file-chat.ts";
import type { createFileConversation } from "./file-conversation.ts";

export interface ConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly calls: readonly { readonly id: string; readonly name: string }[];
}
export interface ConversationQuestion {
  readonly id: string;
  readonly root: string;
  readonly execution: string;
  readonly grant: ResolutionGrant;
  readonly context: { readonly path: string; readonly step: "read" | "confirm" | "repair" };
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
  readonly text: string;
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
          const state = yield* conversation.read(row.execution);
          const messages: ConversationMessage[] = [
            {
              id: JSON.stringify([row.execution, "user"]),
              role: "user",
              text: row.prompt,
              calls: [],
            },
          ];
          // Use each turn's own accepted samples, never its cumulative terminal
          // transcript: otherwise a second turn duplicates the predecessor's messages.
          for (let offset = 0; offset < state.history.end.position; ) {
            const entries = yield* state.history.read(offset, 128);
            if (!entries.length) {
              throw new Error("Incomplete accepted conversation prefix");
            }
            for (const entry of entries) {
              if (
                entry.request.effect !== `${fileConversationProgram}/sample` ||
                !entry.outcome.ok
              ) {
                continue;
              }
              const result = sample.safeParse(entry.outcome.value);
              if (!result.success) {
                throw new Error("Unsupported accepted conversation sample");
              }
              const content = result.data.value.response.message.content;
              messages.push({
                id: JSON.stringify([row.execution, entry.receipt]),
                role: "assistant",
                text: content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text ?? "")
                  .join(""),
                calls: content.flatMap((part) =>
                  part.type === "tool-call" && part.toolCall ? [part.toolCall] : [],
                ),
              });
            }
            offset = entries.at(-1)!.sequence + 1;
          }
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
              id: JSON.stringify([
                question.execution,
                question.grant.requestId,
                question.grant.resolutionId,
              ]),
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

/** Minimal headless consumer. No optimistic answer acceptance or implicit advancement.
 * Repeated refresh replaces a complete view; late refreshes cannot overwrite newer
 * ones. Disposal forgets display state but does not cancel server-owned execution. */
export function createConversationViewer(transport: {
  observe(): Promise<ConversationView>;
  answer(command: ConversationAnswer): Promise<ConversationAnswerReceipt>;
}) {
  let view: ConversationView | undefined;
  let generation = 0;
  let closed = false;
  function check() {
    if (closed) {
      throw new Error("Conversation viewer is closed");
    }
  }
  return {
    get view() {
      return view;
    },
    async refresh() {
      check();
      const request = ++generation;
      const observed = await transport.observe();
      if (!closed && request === generation) {
        view = observed;
      }
      return view;
    },
    answer(question: ConversationQuestion, text: string) {
      check();
      return transport.answer({
        root: question.root,
        execution: question.execution,
        grant: { ...question.grant },
        text,
      });
    },
    close() {
      closed = true;
      generation++;
      view = undefined;
    },
  };
}
