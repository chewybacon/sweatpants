import { assertJson, type Json } from "@sweatpants/foundation";
import { encode } from "@sweatpants/primitive-journal";
import { decodeModelResponse } from "@sweatpants/model-provider";
import type { ChatAssistantMessage } from "@sweatpants/chat-contract";
import {
  decodeConversationWindow,
  decodeConversationAuthority,
  type ConversationStreamEvent,
} from "@sweatpants/chat-core";
import type { ToolDefinition } from "@sweatpants/agent-sdk";
import { resolveTurnDisposition } from "./disposition.ts";
import type { ChatStore } from "./store.ts";
import type { ChatRequest, TurnInput } from "./chat.ts";

export interface LiveSample {
  execution: string;
  sequence: number;
  request: ChatRequest;
  message: ChatAssistantMessage;
}

/** Projection reads accepted history; provisional samples are presentation only. */
export function reconcileAndProjectChat(
  store: ChatStore,
  conversation: string,
  tools: readonly Pick<ToolDefinition, "name" | "artifacts" | "bindings">[],
  live?: LiveSample,
) {
  const roots: unknown[] = [];
  const interrupts: { id: string; reason: string; message: string }[] = [];
  let active: string | null = null;
  let completed: string | null = null;
  let state = "idle";
  const turns = store.turns(conversation);
  let disposition: ReturnType<typeof resolveTurnDisposition> | undefined;
  for (const turn of turns) {
    const cached = store.projection(turn.identity.executionId) as { roots: Json[] } | undefined;
    if (cached) {
      roots.push(...cached.roots);
      completed = turn.identity.executionId;
      if (turn === turns.at(-1)) {
        const journal = store.journal(turn);
        try {
          disposition = resolveTurnDisposition(journal);
        } finally {
          journal.close();
        }
      }
      continue;
    }
    const rootStart = roots.length;
    const journal = store.journal(turn);
    try {
      store.reconcileAnswers(turn, journal);
      disposition = resolveTurnDisposition(journal);
      const { snapshot, requests, terminal } = disposition;
      const execution = turn.identity.executionId;
      const base = {
        attribution: {},
        logicalTurnId: execution,
        executionId: execution,
        state: terminal ? "sealed" : "mutable",
      };
      // Positions reserve a whole turn, so appending activity never renumbers history.
      let slot = 0;
      const position = () => turn.ordinal * 1000000 + slot++;
      const message = (id: string, role: string, content: string, reasoning?: string) => {
        const sequence = position();
        roots.push({
          ...base,
          // CONDITIONAL-SPREAD: persisted JSON omits absent reasoning.
          ...(reasoning ? { reasoning } : {}),
          kind: "message",
          rootId: id,
          position: String(sequence),
          message: { id, role, content },
          placement: { type: "root", sequence },
        });
      };
      const input = turn.identity.input as TurnInput;
      message(input.messageId, "user", input.text);
      const samples = snapshot.entries.flatMap((entry) => {
        const request = entry.request as ChatRequest;
        return request.kind === "sample" && entry.outcome.ok
          ? [
              {
                sequence: entry.sequence,
                message: decodeModelResponse(entry.outcome.value).message,
              },
            ]
          : [];
      });
      const provisional =
        live?.execution === execution
          ? live
          : (store.presentation(execution) as LiveSample | undefined);
      if (
        provisional?.execution === execution &&
        provisional.request.kind === "sample" &&
        !samples.some((sample) => sample.sequence === provisional.sequence)
      ) {
        samples.push({ sequence: provisional.sequence, message: provisional.message });
      }
      for (const sample of samples) {
        const acceptedSample = snapshot.entries.some((entry) => entry.sequence === sample.sequence);
        const messageId = `${execution}:sample:${sample.sequence}`;
        const calls = sample.message.content
          .filter((part) => part.type === "tool-call")
          .map((part) => part.toolCall);
        message(
          messageId,
          "assistant",
          sample.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
          sample.message.content
            .filter((part) => part.type === "reasoning")
            .map((part) => part.text)
            .join(""),
        );
        for (const [callIndex, call] of calls.entries()) {
          const toolNode = `${messageId}:tool:${call.id}`;
          const messageNode = `activity-message:${messageId}`;
          const result = snapshot.entries.find((entry) => {
            const r = entry.request as ChatRequest;
            return (
              r.kind === "tool-result" && r.callId === call.id && entry.sequence > sample.sequence
            );
          });
          const resultError = result
            ? (result.request as Extract<ChatRequest, { kind: "tool-result" }>).isError
            : false;
          const output = result
            ? (result.request as Extract<ChatRequest, { kind: "tool-result" }>).output
            : undefined;
          const node = (id: string, sequence: number, content: unknown) => ({
            activityRecordId: id,
            producerSequence: sequence,
            event: {
              type: "ACTIVITY_SNAPSHOT",
              messageId: id,
              activityType: "sweatpants:public-execution",
              content: { version: 1, node: content },
              replace: true,
            },
          });
          const nodes = [
            node(toolNode, 0, {
              nodeId: toolNode,
              parentNodeId: messageNode,
              sequence: callIndex,
              presentation: "public",
              kind: "tool-call",
              state:
                output !== undefined
                  ? resultError
                    ? "output-error"
                    : "output-available"
                  : terminal
                    ? "output-error"
                    : acceptedSample
                      ? "input-available"
                      : "input-streaming",
              publicData: {
                kind: "tool-call",
                callId: call.id,
                name: call.name,
                input: call.input,
                rawInput: JSON.stringify(call.input),
                // CONDITIONAL-SPREAD: persisted activity JSON distinguishes no output from a JSON result.
                ...(output !== undefined
                  ? resultError
                    ? {
                        output,
                        errorText:
                          typeof output === "object" && output !== null && "error" in output
                            ? String(output.error)
                            : "Tool failed",
                      }
                    : { output }
                  : terminal
                    ? { errorText: "Execution did not complete" }
                    : {}),
              },
            }),
          ];
          for (const occurrence of requests) {
            const request = occurrence.request as ChatRequest;
            if (
              request.kind !== "elicit" ||
              request.callId !== call.id ||
              occurrence.sequence < sample.sequence ||
              (result && occurrence.sequence > result.sequence)
            ) {
              continue;
            }
            if (occurrence.status === "pending" && !terminal) {
              interrupts.push({
                id: occurrence.id,
                reason: "input_required",
                message: request.message,
              });
            }
            const tool = tools.find((entry) => entry.name === request.tool)!;
            const artifact = tool.artifacts.elicits[request.key];
            const answer = snapshot.entries[occurrence.sequence]?.outcome;
            const cancelled =
              answer?.ok && (answer.value as { action?: string })?.action === "cancel";
            nodes.push(
              node(occurrence.id, occurrence.sequence + 1, {
                nodeId: occurrence.id,
                parentNodeId: toolNode,
                sequence: occurrence.sequence + 1,
                presentation: "public",
                kind: "elicit",
                state:
                  occurrence.status === "accepted"
                    ? cancelled
                      ? "cancelled"
                      : "responded"
                    : terminal
                      ? "cancelled"
                      : "pending",
                publicData: {
                  kind: "elicit",
                  elicitId: occurrence.id,
                  bindingId: tool.bindings.elicits[request.key].id,
                  key: request.key,
                  message: request.message,
                  context: request.context,
                  responseContract: artifact.response,
                  contextContract: artifact.context,
                  toolName: request.tool,
                  callId: request.callId,
                  producerSequence: occurrence.sequence + 1,
                },
              }),
            );
          }
          for (const entry of snapshot.entries) {
            const request = entry.request as ChatRequest;
            if (
              !(request.kind === "progress" || request.kind === "nested-sample") ||
              request.callId !== call.id ||
              entry.sequence < sample.sequence ||
              (result && entry.sequence > result.sequence)
            ) {
              continue;
            }
            const activityId = `${execution}:activity:${entry.sequence}`;
            const text =
              request.kind === "progress"
                ? request.message
                : entry.outcome.ok
                  ? (entry.outcome.value as { text: string }).text
                  : "Sample failed";
            nodes.push(
              node(activityId, entry.sequence + 1, {
                nodeId: activityId,
                parentNodeId: toolNode,
                sequence: entry.sequence + 1,
                presentation: "public",
                kind: "activity",
                state: "complete",
                publicData: {
                  kind: "activity",
                  activityType: request.kind,
                  data: { message: text },
                },
              }),
            );
          }
          if (
            provisional?.request.kind === "nested-sample" &&
            provisional.request.callId === call.id &&
            provisional.sequence > sample.sequence &&
            !snapshot.entries.some((entry) => entry.sequence === provisional.sequence)
          ) {
            const activityId = `${execution}:activity:${provisional.sequence}`;
            nodes.push(
              node(activityId, provisional.sequence + 1, {
                nodeId: activityId,
                parentNodeId: toolNode,
                sequence: provisional.sequence + 1,
                presentation: "public",
                kind: "activity",
                state: terminal ? "cancelled" : "running",
                publicData: {
                  kind: "activity",
                  activityType: "nested-sample",
                  data: {
                    message: provisional.message.content
                      .filter((part) => part.type === "text" || part.type === "reasoning")
                      .map((part) => part.text)
                      .join(""),
                  },
                },
              }),
            );
          }
          roots.push({
            ...base,
            rootId: toolNode,
            position: String(position()),
            kind: "activity-subtree",
            rootNodeId: toolNode,
            producerSequence: nodes.length,
            anchors: [
              {
                nodeId: messageNode,
                parentNodeId: null,
                sequence: 0,
                kind: "message",
                presentation: "public",
                publicData: { kind: "message", messageId, role: "assistant" },
              },
            ],
            nodes,
            unloadedDescendantCount: 0,
          });
        }
      }
      if (
        terminal &&
        provisional?.request.kind === "sample" &&
        !snapshot.entries.some((entry) => entry.sequence === provisional.sequence)
      ) {
        const messageId = `${execution}:sample:${provisional.sequence}`;
        const messageNode = `activity-message:${messageId}`;
        const nodeId = `${messageId}:interrupted`;
        roots.push({
          ...base,
          rootId: nodeId,
          position: String(position()),
          kind: "activity-subtree",
          rootNodeId: nodeId,
          producerSequence: 0,
          anchors: [
            {
              nodeId: messageNode,
              parentNodeId: null,
              sequence: 0,
              kind: "message",
              presentation: "public",
              publicData: { kind: "message", messageId, role: "assistant" },
            },
          ],
          nodes: [
            {
              activityRecordId: nodeId,
              producerSequence: 0,
              event: {
                type: "ACTIVITY_SNAPSHOT",
                messageId: nodeId,
                activityType: "sweatpants:public-execution",
                replace: true,
                content: {
                  version: 1,
                  node: {
                    nodeId,
                    parentNodeId: messageNode,
                    sequence: provisional.message.content.length + 1,
                    presentation: "public",
                    kind: "activity",
                    state: snapshot.status === "cancelled" ? "cancelled" : "error",
                    publicData: {
                      kind: "activity",
                      activityType: "interrupted-response",
                      data: { message: "Partial response — interrupted before completion." },
                    },
                  },
                },
              },
            },
          ],
          unloadedDescendantCount: 0,
        });
      }
      if (terminal) {
        completed = execution;
        store.sealProjection(execution, assertJson({ roots: roots.slice(rootStart) }));
      } else {
        active = execution;
        state = disposition.state;
      }
    } finally {
      journal.close();
    }
  }
  const revision = roots.length
    ? store.revision(conversation, encode(assertJson({ roots, state, active, completed })))
    : null;
  const authority = decodeConversationAuthority({
    conversationId: conversation,
    revision,
    state,
    activeLogicalTurnId: active,
    activeExecutionId: active,
    latestCompletedExecutionId: completed,
  });
  const hot = roots.slice(-256);
  const window = decodeConversationWindow({
    type: "sweatpants.conversation-window.v1",
    conversationId: conversation,
    lineageId: `primitive:${conversation}`,
    basisRevision: revision ?? "0",
    windowToken: `${conversation}:${revision ?? "0"}`,
    windowMode: "reset",
    archiveFrontierOrdinal: "0",
    nextPublicPosition: String(store.turns(conversation).length * 1000000),
    hotRoots: hot,
    sealedCatchupRoots: [],
    applicationState: {},
    olderHistoryCursor: roots.length > hot.length ? String(roots.length - hot.length) : null,
  });
  const frames: ConversationStreamEvent[] = [
    window,
    { type: "sweatpants.conversation-authority.v1", authority },
  ];
  return { frames, authority, interrupts, disposition, roots: roots as Json[] };
}
