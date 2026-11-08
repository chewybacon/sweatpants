import { z } from "zod";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatSampling, ChatHistoryMessage, ChatLoopResult } from "@sweatpan.ts/chat";
import {
  defineChatProgram,
  createChatToolBinding,
  type ChatRecoveryFactory,
} from "@sweatpan.ts/chat-host";
import type { OwnedJournal } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import { defineTool } from "@sweatpan.ts/tools";

// Complete application policy; placement and typed sampling are supplied by the host.
const chatInput = z.object({ prompt: z.string().min(1) });
const fileInput = z.object({
  path: z.string().min(1),
  mode: z.enum(["single", "followup", "cleanup"]),
});
const fileAnswer = defineEffect({
  key: "file-chat.answer-v1",
  context: z.object({ path: z.string(), step: z.enum(["read", "confirm", "repair"]) }),
  response: z.string().min(1),
});

// Workflow authoring: all durable waits, including cleanup, are ordinary elicit calls.
const readFile = defineTool("file-reader-v1")
  .parameters(fileInput)
  .elicits({ file: fileAnswer })
  .execute(function* ({ path, mode }, ctx) {
    if (mode === "cleanup") {
      yield* ctx.scope.ensure(function* () {
        const answer = yield* ctx.elicit("file", { path, step: "repair" });
        if (!answer.ok) {
          throw new Error("Repair was not supplied");
        }
      });
      return "cleaned";
    }
    const answer = yield* ctx.elicit("file", { path, step: "read" });
    if (!answer.ok) {
      throw new Error("File was not supplied");
    }
    if (mode === "followup") {
      const confirmation = yield* ctx.elicit("file", { path, step: "confirm" });
      if (!confirmation.ok) {
        throw new Error("Confirmation was not supplied");
      }
      return `${answer.value}: ${confirmation.value}`;
    }
    return answer.value;
  });

// A second concrete tool exposes nested sampling in the public projection.
export const fileReviewSample = defineEffect({
  key: "file-review.sample-v1",
  context: z.object({ text: z.string() }),
  response: z.object({ text: z.string() }),
});
const reviewFile = defineTool("file-reviewer-v1")
  .parameters(z.object({ path: z.string() }))
  .capabilities({ sample: fileReviewSample })
  .elicits({ file: fileAnswer })
  .execute(function* ({ path }, ctx) {
    const answer = yield* ctx.elicit("file", { path, step: "read" });
    if (!answer.ok) {
      throw new Error("File was not supplied");
    }
    const review = yield* ctx.capabilities.sample({ text: answer.value });
    if (!review.ok) {
      throw new Error("Review unavailable");
    }
    return review.value.text;
  });

const program = defineChatProgram({
  id: "file-chat-v2",
  history(admitted) {
    return [{ role: "user", content: chatInput.parse(admitted).prompt }];
  },
  toolResult(value) {
    return { content: z.string().parse(value), isError: false };
  },
  result(completed) {
    return completed.response.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  },
});
export const fileChatProgram = program.id;

export interface FileChatDependencies<Y> {
  readonly recovery: ChatRecoveryFactory<Y>;
  readonly sampling: ChatSampling<Y>;
  readonly matches: (actual: CapabilityRequest, accepted: CapabilityRequest) => boolean;
}

function fileTool<Y>(runtime: Runtime<Y>, dependencies: FileChatDependencies<Y>) {
  return createChatToolBinding(runtime, readFile, {
    definition: {
      name: "read_file",
      description: "Read a file, optionally confirm it or obtain cleanup assistance.",
      parameters: z.record(z.string(), z.json()).parse(z.toJSONSchema(fileInput, { io: "input" })),
    },
    recovery: dependencies.recovery,
    matches: dependencies.matches,
  });
}

/** Bind a previously admitted root. Recreate after reopening the connection. */
export function createFileChat<Y>(
  runtime: Runtime<Y>,
  journal: OwnedJournal<string, CapabilityRequest, unknown, string, unknown, Y>,
  dependencies: FileChatDependencies<Y>,
) {
  return program.bind(runtime, {
    journal,
    tools: [fileTool(runtime, dependencies)],
    ...dependencies,
  });
}

// History is constructed from a verified predecessor's terminal result by the server
// conversation adapter. This array assertion is not a client history wire validator.
const turnInput = z.object({
  prompt: z.string().min(1),
  history: z.custom<readonly ChatHistoryMessage[]>(Array.isArray),
});
const conversationTurn = defineChatProgram({
  id: "file-conversation-turn-v2",
  history(admitted) {
    const input = turnInput.parse(admitted);
    return [...input.history, { role: "user", content: input.prompt }];
  },
  toolResult(value) {
    return { content: z.string().parse(value), isError: false };
  },
  result(completed) {
    return completed;
  },
});
export const fileConversationProgram = conversationTurn.id;

/** A conversation turn retains the complete accepted transcript in its terminal value. */
export function createFileConversationTurn<Y>(
  runtime: Runtime<Y>,
  journal: OwnedJournal<ChatLoopResult, CapabilityRequest, unknown, string, unknown, Y>,
  dependencies: FileChatDependencies<Y>,
) {
  return conversationTurn.bind(runtime, {
    journal,
    tools: [
      fileTool(runtime, dependencies),
      createChatToolBinding(runtime, reviewFile, {
        definition: {
          name: "review_file",
          description: "Review supplied file contents.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        recovery: dependencies.recovery,
        matches: dependencies.matches,
        *configure({ effects }) {
          yield* effects.install(fileReviewSample, function* ({ text }) {
            const sampled = yield* dependencies.sampling.sample({
              round: 0,
              history: [{ role: "user", content: text }],
              tools: [],
            });
            if (!sampled.ok) {
              return sampled;
            }
            return {
              ok: true as const,
              value: {
                text: sampled.value.response.message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join(""),
              },
            };
          });
        },
      }),
    ],
    ...dependencies,
  });
}
