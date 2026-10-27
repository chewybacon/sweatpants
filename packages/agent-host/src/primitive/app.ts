import { validateToolAnswer } from "@sweatpants/agent-sdk";
import { effection } from "@sweatpants/standard-durability-effection";
import { runtime } from "@sweatpants/runtime-effection";
import type { RuntimeExecution } from "@sweatpants/foundation/computation";
import { prepareChatExecution, startChatActivation } from "./activation.ts";
import { effectionModelStream, type PrimitiveChatOptions } from "./effection.ts";
import { z } from "zod";
import { assertJson, type Json } from "@sweatpants/foundation";
import { type JournalRequest } from "@sweatpants/agent-sdk";
import { createChatRouter, normalizeChatBasePath } from "../server/chat-router.ts";
import { acceptedMessages, type TurnInput } from "./chat.ts";
import { resolveTurnDisposition } from "./disposition.ts";
import { ChatStore, type TurnRecord } from "./store.ts";
import { reconcileAndProjectChat, type LiveSample } from "./presentation.ts";
export type { PrimitiveChatOptions } from "./effection.ts";

const id = z.string().min(1).max(1024);
const base = {
  commandId: z.uuid(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  basisRevision: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .nullable(),
};
const envelopeSchema = z.strictObject({
  conversationId: id,
  clientId: id,
  knownWindowToken: id.optional(),
  runId: id.optional(),
  parentRunId: id.optional(),
  state: z.strictObject({}).optional(),
  context: z.tuple([]).optional(),
  forwardedProps: z.strictObject({}).optional(),
  systemPrompt: z.string().optional(),
  model: z.json().optional(),
  initialToolChoice: z.enum(["auto", "none", "required"]).optional(),
  userMessage: z.strictObject({ id, role: z.literal("user"), content: z.string() }).optional(),
  command: z.discriminatedUnion("type", [
    z.strictObject({ ...base, type: z.literal("send-message"), messageId: id }),
    z.strictObject({
      ...base,
      type: z.literal("interrupt-turn"),
      logicalTurnId: id.nullable(),
      executionId: id.nullable(),
      reason: z.string(),
    }),
    z.strictObject({
      ...base,
      type: z.literal("respond-to-elicit"),
      logicalTurnId: id,
      executionId: id,
      interruptId: id,
      status: z.enum(["resolved", "cancelled"]),
      payload: z.json().optional(),
    }),
  ]),
});

/** Experimental single-owner chat host. Deployment policy authorizes every read and command. */
export function createPrimitiveChatApp(options: PrimitiveChatOptions) {
  if (
    !options.program.digest ||
    !options.model.identity ||
    typeof options.authorize !== "function"
  ) {
    throw new Error("Pinned release, model identity and trusted access policy are required");
  }
  if (new Set(options.tools.map((tool) => tool.name)).size !== options.tools.length) {
    throw new Error("Duplicate tools");
  }
  for (const tool of options.tools) {
    for (const key of Object.keys(tool.effects)) {
      if (!(`${tool.name}.${key}` in options.effects)) {
        throw new Error(`Missing effect handler: ${tool.name}.${key}`);
      }
    }
  }
  const allowed = new Set([
    "database",
    "basePath",
    "program",
    "model",
    "tools",
    "effects",
    "effectMiddleware",
    "execution",
    "authorize",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new Error(`Unsupported primitive host option: ${key}`);
    }
  }
  const preparedExecution = options.execution?.prepare(options.tools, "tools");
  prepareChatExecution(options.tools, preparedExecution);
  const store = new ChatStore(options.database, options.program);
  for (const turn of store.turns()) {
    if (
      !options.model.resolve &&
      (turn.identity.input as TurnInput).modelIdentity !== options.model.identity
    ) {
      store.close();
      throw new Error("Model configuration identity mismatch");
    }
  }
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  type Owner = {
    failure?: { code: string; message: string };
    task?: RuntimeExecution<unknown>;
    done: Promise<void>;
    live?: LiveSample;
    listeners: Set<() => void>;
  };
  const owners = new Map<string, Owner>();
  const project = (conversation: string) =>
    reconcileAndProjectChat(
      store,
      conversation,
      options.tools,
      [...owners.values()].find(
        (owner) =>
          owner.live &&
          store
            .turns(conversation)
            .some((turn) => turn.identity.executionId === owner.live!.execution),
      )?.live,
    );
  const serialize = (work: () => Promise<Response>) => {
    const next = tail.then(async () => {
      if (closed) {
        return Response.json({ error: "host_closed" }, { status: 503 });
      }
      try {
        return await work();
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 409 },
        );
      }
    });
    tail = next.then(() => {});
    return next;
  };
  function start(turn: TurnRecord): Owner {
    const execution = turn.identity.executionId;
    const existing = owners.get(execution);
    if (existing) {
      return existing;
    }
    const owner: Owner = { done: Promise.resolve(), listeners: new Set() };
    owners.set(execution, owner);
    owner.done = Promise.resolve()
      .then(async () => {
        const journal = store.journal(turn);
        try {
          store.reconcileAnswers(turn, journal);
          const disposition = resolveTurnDisposition(journal, { type: "interrupt" });
          if (disposition.state !== "running") {
            return;
          }
          owner.task = startChatActivation(
            runtime,
            effection,
            {
              ...options,
              execution: preparedExecution ? { prepare: () => preparedExecution } : undefined,
              model: {
                ...options.model,
                driver: effectionModelStream(options.model.driver),
                model:
                  options.model.resolve?.((turn.identity.input as TurnInput).modelIdentity) ??
                  options.model.model,
              },
            },
            turn.identity.input as TurnInput,
            journal,
            {
              accepted() {
                owner.live = undefined;
                for (const listener of owner.listeners) {
                  listener();
                }
              },
              publish(event, request) {
                if ("partial" in event) {
                  owner.live = {
                    execution,
                    sequence: journal.read().entries.length,
                    request,
                    message: event.partial,
                  };
                  store.publish(execution, assertJson(owner.live));
                  for (const listener of owner.listeners) {
                    listener();
                  }
                }
              },
            },
          );
          await owner.task.result;
        } catch (error) {
          const snapshot = journal.read();
          if (
            !closed &&
            snapshot.status === "interrupting" &&
            !(error instanceof Error && error.message === "halted")
          ) {
            owner.failure = {
              code: "OUTCOME_UNKNOWN",
              message: error instanceof Error ? error.message : String(error),
            };
          }
          if (!closed && snapshot.status !== "interrupting") {
            try {
              resolveTurnDisposition(journal, {
                type: "failure",
                reason: error instanceof Error ? error.message : String(error),
              });
            } catch {
              owner.failure = {
                code: "OUTCOME_UNKNOWN",
                message: `outcome_unknown: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }
        } finally {
          owner.task = undefined;
          journal.close();
        }
      })
      .finally(() => {
        const check = store.journal(turn);
        try {
          if (check.read().status === "interrupting" && !owner.failure) {
            return;
          }
        } finally {
          check.close();
        }
        owners.delete(execution);
        for (const listener of owner.listeners) {
          listener();
        }
        owner.listeners.clear();
      });
    // The stream reports failure; this observer prevents an unhandled rejection when no subscribers remain.
    void owner.done.catch(() => {});
    return owner;
  }
  function stream(conversation: string, execute: boolean, runId: string) {
    let owner: Owner | undefined;
    let listener: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false;
        const emit = (frame: unknown) =>
          controller.enqueue(new TextEncoder().encode(JSON.stringify(frame) + "\n"));
        const publish = () => {
          if (ended) {
            return;
          }
          if (closed) {
            ended = true;
            controller.error(new Error("host_closed"));
            return;
          }
          const projection = project(conversation);
          for (const frame of projection.frames) {
            emit(frame);
          }
          if (!execute || projection.authority.state !== "running" || owner?.failure) {
            if (execute) {
              const failure = owner?.failure ?? projection.disposition?.failure;
              emit(
                failure
                  ? { type: "RUN_ERROR", ...failure }
                  : {
                      type: "RUN_FINISHED",
                      threadId: conversation,
                      runId,
                      // CONDITIONAL-SPREAD: only parked wire terminals carry an interrupt outcome.
                      ...(projection.authority.state === "parked"
                        ? { outcome: { type: "interrupt", interrupts: projection.interrupts } }
                        : {}),
                    },
              );
            }
            ended = true;
            controller.close();
          }
        };
        if (execute) {
          emit({ type: "RUN_STARTED", threadId: conversation, runId });
        }
        publish();
        if (execute && !ended) {
          const turn = store.turns(conversation).at(-1)!;
          owner = start(turn);
          listener = publish;
          owner.listeners.add(listener);
          void owner.done.catch((error) => {
            if (!ended) {
              ended = true;
              controller.error(error);
            }
          });
        }
      },
      cancel() {
        if (owner && listener) {
          owner.listeners.delete(listener);
        }
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  }
  const router = createChatRouter(normalizeChatBasePath(options.basePath ?? "/assistant/chat"), {
    postChat: (request) =>
      serialize(async () => {
        const envelope = envelopeSchema.parse(await request.json());
        const { conversationId: conversation, command } = envelope;
        if (!(await options.authorize(request, conversation))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        if (closed) {
          throw new Error("host_closed");
        }
        const canonical = assertJson(envelope);
        const duplicate = store.command(command.commandId, canonical);
        let projection = project(conversation);
        if (!duplicate) {
          if (
            command.expiresAt <= Date.now() ||
            command.issuedAt > Date.now() ||
            command.expiresAt <= command.issuedAt
          ) {
            throw new Error("command_expired");
          }
          if (
            command.type !== "interrupt-turn" &&
            command.basisRevision !== projection.authority.revision
          ) {
            throw new Error("stale_revision");
          }
          if (command.type === "interrupt-turn") {
            const turn = store.turns(conversation).at(-1);
            if (
              !turn ||
              command.executionId !== projection.authority.activeExecutionId ||
              command.executionId !== turn.identity.executionId ||
              command.logicalTurnId !== turn.identity.executionId
            ) {
              throw new Error("Invalid interruption target");
            }
            store.interrupt(turn.identity.executionId, command.commandId, canonical);
          } else if (command.type === "send-message") {
            for (const turn of store.turns()) {
              if (store.projection(turn.identity.executionId)) {
                continue;
              }
              const journal = store.journal(turn);
              try {
                const snapshot = journal.read();
                const unsafe = snapshot.attempts.some(
                  (attempt) =>
                    attempt.sequence === snapshot.entries.length && attempt.retryMode === "unsafe",
                );
                if (
                  ["running", "interrupting"].includes(snapshot.status) &&
                  (turn.conversation === conversation || unsafe)
                ) {
                  throw new Error("execution_busy");
                }
              } finally {
                journal.close();
              }
            }
            const turns = store.turns(conversation);
            if (!envelope.userMessage || envelope.userMessage.id !== command.messageId) {
              throw new Error("Invalid user message");
            }
            let messages: Json[] = [];
            const prior = turns.at(-1);
            if (prior) {
              const journal = store.journal(prior);
              try {
                const snapshot = journal.read();
                messages = acceptedMessages(prior.identity.input as TurnInput, snapshot.entries);
              } finally {
                journal.close();
              }
            }
            if (!messages.length && envelope.systemPrompt) {
              messages.push({
                role: "system",
                content: [{ type: "text", text: envelope.systemPrompt }],
              });
            }
            messages.push({
              role: "user",
              content: [{ type: "text", text: envelope.userMessage.content }],
            });
            store.admit(
              conversation,
              {
                messageId: command.messageId,
                text: envelope.userMessage.content,
                messages,
                modelIdentity: options.model.select?.(envelope.model) ?? options.model.identity,
                // CONDITIONAL-SPREAD: persisted inputs omit an absent choice to preserve journal identity.
                ...(envelope.initialToolChoice
                  ? { initialToolChoice: envelope.initialToolChoice }
                  : {}),
              },
              command.commandId,
              canonical,
            );
          } else {
            if (
              envelope.userMessage ||
              command.executionId !== projection.authority.activeExecutionId ||
              command.logicalTurnId !== projection.authority.activeLogicalTurnId
            ) {
              throw new Error("Invalid answer target");
            }
            const turn = store.turns(conversation).at(-1)!;
            const journal = store.journal(turn);
            try {
              const occurrence = journal
                .readRequests()
                .find((entry) => entry.id === command.interruptId && entry.status === "pending");
              if (!occurrence) {
                throw new Error("No pending request");
              }
              const pending = occurrence.request as JournalRequest;
              if (pending.kind !== "elicit") {
                throw new Error("Invalid request kind");
              }
              const tool = options.tools.find((entry) => entry.name === pending.tool)!;
              const answer =
                command.status === "cancelled" ? { action: "cancel" } : command.payload;
              const rawAnswer = validateToolAnswer(tool, pending.key, answer);
              // A read can expose the parked request before remote Guest disposal joins.
              // Finish that activation before accepting an answer that needs a fresh cursor.
              await owners.get(turn.identity.executionId)?.done;
              if (resolveTurnDisposition(journal).state !== "parked") {
                throw new Error("Elicitation is no longer pending");
              }
              store.answer(
                turn.identity.executionId,
                command.commandId,
                canonical,
                occurrence.id,
                rawAnswer,
              );
              store.reconcileAnswers(turn, journal);
            } finally {
              journal.close();
            }
          }
          projection = project(conversation);
        }
        if (command.type === "interrupt-turn") {
          // A receipt pins the target, but says nothing about its settlement.
          const execution = duplicate ?? command.executionId;
          const turn = store
            .turns(conversation)
            .find((entry) => entry.identity.executionId === execution);
          if (!turn) {
            throw new Error("Invalid interruption target");
          }
          const journal = store.journal(turn);
          const owner = owners.get(turn.identity.executionId);
          try {
            store.reconcileAnswers(turn, journal);
            projection = project(conversation);
            await owner?.task?.cancel();
            await owner?.done;
            const disposition = resolveTurnDisposition(journal, { type: "interrupt" });
            if (disposition.snapshot.status !== "cancelled") {
              throw new Error("interruption_not_cancelled");
            }
            const result = project(conversation);
            const currentTarget =
              store.turns(conversation).at(-1)?.identity.executionId === execution;
            const terminal = currentTarget
              ? { type: "RUN_ERROR", ...disposition.failure }
              : {
                  type: "RUN_ERROR",
                  code: "INTERRUPT_ALREADY_SETTLED",
                  message: `Target ${execution} was cancelled; a later turn owns the conversation`,
                };
            const frames =
              currentTarget && projection.authority.state === "running"
                ? [
                    { type: "RUN_STARTED", threadId: conversation, runId: command.commandId },
                    ...projection.frames,
                    ...result.frames,
                    terminal,
                  ]
                : [result.frames[1], terminal];
            return new Response(frames.map((frame) => JSON.stringify(frame) + "\n").join(""), {
              headers: { "content-type": "application/x-ndjson" },
            });
          } finally {
            journal.close();
            owners.delete(turn.identity.executionId);
            if (owner) {
              for (const listener of owner.listeners) {
                listener();
              }
              owner.listeners.clear();
            }
          }
        }
        return stream(
          conversation,
          projection.authority.state === "running",
          envelope.runId ?? command.commandId,
        );
      }),
    readChat: ({ request, conversationId }) =>
      serialize(async () => {
        if (!(await options.authorize(request, conversationId))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        if (request.method === "POST") {
          const read = z
            .strictObject({ conversationId: id, clientId: id, knownWindowToken: id.optional() })
            .parse(await request.json());
          if (read.conversationId !== conversationId) {
            throw new Error("Invalid conversation target");
          }
        }
        if (closed) {
          throw new Error("host_closed");
        }
        if (!store.turns(conversationId).length) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        const projection = project(conversationId);
        return stream(
          conversationId,
          projection.authority.state === "running",
          `recover:${conversationId}`,
        );
      }),
    pageHistory: ({ request, conversationId }) =>
      serialize(async () => {
        if (!(await options.authorize(request, conversationId))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const { cursor } = z
          .strictObject({ cursor: z.string().regex(/^\d+$/) })
          .parse(await request.json());
        const roots = project(conversationId).roots;
        const end = Math.min(Number(cursor), roots.length);
        const start = Math.max(0, end - 256);
        return Response.json({
          roots: roots.slice(start, end),
          nextOlderCursor: start ? String(start) : null,
        });
      }),
  });
  let closing: Promise<void> | undefined;
  return {
    handler: router,
    close() {
      return (closing ??= (async () => {
        closed = true;
        let failure: unknown;
        let failed = false;
        // Attempt every cleanup step, retaining the first (native) failure.
        for (const cleanup of [
          () => Promise.all([...owners.values()].map((owner) => owner.task?.cancel())),
          () => Promise.all([...owners.values()].map((owner) => owner.done)),
          () => tail,
          () => store.close(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            if (!failed) {
              failure = error;
              failed = true;
            }
          }
        }
        if (failed) {
          throw failure;
        }
      })());
    },
  };
}
