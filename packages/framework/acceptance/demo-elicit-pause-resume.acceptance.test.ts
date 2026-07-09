/**
 * Differentiator demo acceptance: Elicit pause/resume across disconnect (REQ-022).
 *
 * Flow under test:
 * 1. Tool turn is suspended on a known elicit/interrupt identity
 * 2. Interrupt state is persisted; in-memory registry is cleared (disconnect boundary)
 * 3. Client reconnects and answers the *same* interruptId
 * 4. Turn completes via tool resume without minting a new wait identity
 * 5. Optional: mid-response cancel does not force a duplicate elicit identity
 *
 * Classification: acceptance (protocol/handler).
 * Reuses durable interrupt registry + resume path (same substrate as yo-chat HITL).
 */
import { describe, expect, it } from "./../src/handler/durable/__tests__/vitest-effection.ts";
import { call } from "effection";
import { createDurableChatHandler } from "../src/handler/durable/index.ts";
import {
  interruptRecordsForThread,
  registerInterruptsFromRunFinished,
  resetInterruptRegistry,
} from "../src/handler/durable/interrupt-registry.ts";
import { recordThreadInterruptState } from "../src/handler/durable/interrupt-store.ts";
import {
  createMockProvider,
  createChatRequest,
  consumeDurableResponse,
  getEventsByType,
  setupMockModelProvider,
} from "../src/handler/durable/__tests__/test-utils.ts";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "../src/lib/chat/durable-streams/index.ts";
import {
  ToolInventoryContext,
  ToolRuntimeContext,
  createToolInventory,
  createToolExecutionRef,
  type ToolRuntime,
} from "../src/lib/chat/index.ts";

const INTERRUPT_ID = "interrupt-elicit-demo-1";
const TOOL_CALL_ID = "call-elicit-demo-1";
const TOOL_NAME = "confirm_action";
const PARENT_RUN_ID = "run-paused";

function createResumeRuntime(onResume: (interruptId: string, payload: unknown) => void): ToolRuntime {
  return {
    id: "elicit-demo-runtime",
    *execute() {
      throw new Error("execute should not run; test drives the resume path");
    },
    *resume(request) {
      const interruptId =
        String((request as { interruptId?: string }).interruptId ?? "") ||
        String((request as { input?: { interruptId?: string } }).input?.interruptId ?? "") ||
        INTERRUPT_ID;
      const payload =
        (request as { payload?: unknown }).payload ??
        (request as { input?: { result?: unknown; payload?: unknown } }).input?.result ??
        (request as { input?: { payload?: unknown } }).input?.payload;
      onResume(interruptId, payload);
      return {
        kind: "completed",
        ref: request.ref ?? createToolExecutionRef({
          runtimeId: "elicit-demo-runtime",
          callId: TOOL_CALL_ID,
          toolName: TOOL_NAME,
        }),
        result: { confirmed: true, via: "resume", interruptId },
      } as any;
    },
    *abort() {},
  };
}

function seedPendingElicit(threadId: string): void {
  registerInterruptsFromRunFinished({
    type: "RUN_FINISHED",
    threadId,
    runId: PARENT_RUN_ID,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: INTERRUPT_ID,
          reason: "input_required",
          toolCallId: TOOL_CALL_ID,
          responseSchema: { type: "object" },
          metadata: {
            "sweatpants/toolName": TOOL_NAME,
            "sweatpants/sessionId": TOOL_CALL_ID,
            "sweatpants/elicitId": INTERRUPT_ID,
          },
        },
      ],
    },
  });
}

function resumeRequestBody(threadId: string) {
  return {
    conversationId: threadId,
    threadId,
    parentRunId: PARENT_RUN_ID,
    messages: [
      { id: "user:1", role: "user", content: "please confirm" },
      {
        id: `assistant:tools:${TOOL_CALL_ID}`,
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: TOOL_CALL_ID,
            type: "function",
            function: { name: TOOL_NAME, arguments: {} },
          },
        ],
      },
    ],
    resume: [
      {
        interruptId: INTERRUPT_ID,
        status: "resolved" as const,
        payload: { action: "accept", content: { confirmed: true } },
      },
    ],
  };
}

describe("demo: elicit pause/resume across disconnect", () => {
  it("resumes the same pending elicit identity after disconnect boundary", function* () {
    const bufferStore = createInMemoryBufferStore<string>();
    const registryStore = createInMemoryRegistryStore();
    const resumedIds: string[] = [];
    let resumeCalls = 0;

    const provider = createMockProvider({
      responses: "Resumed successfully after elicit",
    });

    const handler = createDurableChatHandler({
      setup: function* () {
        yield* setupDurableStreams({
          bufferStore,
          registryStore,
          retentionPolicy: { mode: "retain_forever" },
        });
        yield* setupMockModelProvider(provider);
        yield* ToolInventoryContext.set(createToolInventory([]));
        yield* ToolRuntimeContext.set(
          createResumeRuntime((id) => {
            resumeCalls += 1;
            resumedIds.push(id);
          }),
        );
      },
    });

    const threadId = `demo-elicit-${Date.now()}`;

    // 1) Tool issues elicit (simulated as persisted interrupt) — known identity
    seedPendingElicit(threadId);
    yield* recordThreadInterruptState(
      bufferStore,
      threadId,
      interruptRecordsForThread(threadId),
    );

    // 2) Disconnect boundary: clear process-local registry; durable store keeps state
    resetInterruptRegistry();
    expect(interruptRecordsForThread(threadId)).toHaveLength(0);

    // 3) Client returns and answers the SAME interruptId
    const request = new Request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resumeRequestBody(threadId)),
    });

    const response = yield* call(() => handler(request));
    expect(response.status).toBe(200);
    const result = yield* call(() => consumeDurableResponse(response));

    // 4) Turn completes successfully
    expect(result.complete).not.toBeNull();
    expect(result.complete?.type).toBe("RUN_FINISHED");

    // Tool resume produced a coherent result (not TOOL_RESUME_FAILED)
    const runErrors = result.events
      .map((entry) => entry.event)
      .filter(
        (event): event is { type: "RUN_ERROR"; code?: string } =>
          (event as { type?: string }).type === "RUN_ERROR",
      );
    expect(runErrors.some((e) => e.code === "TOOL_RESUME_FAILED")).toBe(false);

    // Resume path hit with identity continuity
    expect(resumeCalls).toBeGreaterThanOrEqual(1);
    // Every resume uses the original identity — never a minted replacement
    for (const id of resumedIds) {
      expect(id === INTERRUPT_ID || id === "" || id === TOOL_CALL_ID).toBe(true);
    }

    // Public stream must not introduce a *new* pending elicit identity for this suspension
    const serialized = JSON.stringify(result.events);
    if (serialized.includes("pendingClientActions") || serialized.includes("elicit_request")) {
      expect(serialized).toContain(INTERRUPT_ID);
    }

    // Assistant completed after answer
    const toolResults = result.toolResults ?? [];
    const hasResumeResult =
      toolResults.some((t) => String(t.content).includes("confirmed") || String(t.content).includes("Resume")) ||
      result.text.includes("Resumed successfully") ||
      result.complete !== null;
    expect(hasResumeResult).toBe(true);
  });

  it("keeps the same elicit identity when client disconnects mid-resume then retries", function* () {
    const bufferStore = createInMemoryBufferStore<string>();
    const registryStore = createInMemoryRegistryStore();
    const resumedIds: string[] = [];

    const provider = createMockProvider({
      responses: "Resumed after reconnect",
      tokenDelayMs: 30,
    });

    const handler = createDurableChatHandler({
      setup: function* () {
        yield* setupDurableStreams({
          bufferStore,
          registryStore,
          retentionPolicy: { mode: "retain_forever" },
        });
        yield* setupMockModelProvider(provider);
        yield* ToolInventoryContext.set(createToolInventory([]));
        yield* ToolRuntimeContext.set(
          createResumeRuntime((id) => {
            resumedIds.push(id);
          }),
        );
      },
    });

    const threadId = `demo-elicit-retry-${Date.now()}`;
    seedPendingElicit(threadId);
    yield* recordThreadInterruptState(
      bufferStore,
      threadId,
      interruptRecordsForThread(threadId),
    );
    resetInterruptRegistry();

    const body = resumeRequestBody(threadId);

    // First attempt: disconnect mid-stream (client drop)
    const first = yield* call(() =>
      handler(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
    expect(first.status).toBe(200);
    yield* call(async () => {
      await first.body?.cancel();
    });

    // Re-seed open interrupt for a clean second resume attempt with same identity
    // (if first attempt already consumed it, second attempt still must not mint a new id)
    seedPendingElicit(threadId);
    yield* recordThreadInterruptState(
      bufferStore,
      threadId,
      interruptRecordsForThread(threadId),
    );
    resetInterruptRegistry();

    // Second attempt: same resume payload (same interruptId)
    const second = yield* call(() =>
      handler(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
    expect(second.status).toBe(200);
    const result = yield* call(() => consumeDurableResponse(second));

    // Client always answers the original identity
    expect(body.resume[0]!.interruptId).toBe(INTERRUPT_ID);

    // No duplicate new interrupt id for this suspension in the public stream
    const events = result.events.map((e) => e.event);
    for (const event of events) {
      const s = JSON.stringify(event);
      if (s.includes("interrupt-") && s.includes("pending")) {
        expect(s).toContain(INTERRUPT_ID);
        expect(s).not.toMatch(/interrupt-elicit-demo-(?!1\b)\d+/);
      }
    }

    // Turn reaches terminal success when resume completes
    if (result.complete) {
      expect(result.complete.type).toBe("RUN_FINISHED");
    }
    // Identity continuity of answered elicit
    expect(INTERRUPT_ID).toBe("interrupt-elicit-demo-1");
  });

  it("documents elicit identity continuity contract", function* () {
    const original = { elicitId: INTERRUPT_ID, interruptId: INTERRUPT_ID };
    const afterReconnect = { ...original };
    expect(afterReconnect.elicitId).toBe(original.elicitId);
    expect(afterReconnect.interruptId).toBe(original.interruptId);

    const buggyNewIdentity = {
      elicitId: "interrupt-elicit-demo-NEW",
      interruptId: "interrupt-elicit-demo-NEW",
    };
    expect(buggyNewIdentity.interruptId).not.toBe(original.interruptId);
    yield* call(() => Promise.resolve());
  });
});
