import { describe, expect, it } from "vitest";
import { planTurn } from "@sweatpants/durable-chat-runtime/handler/turn-plan";
import type { ChatRequestBody } from "../types.ts";
import type { OpenInterruptRecord } from "@sweatpants/durable-chat-runtime/interrupts";

function openInterrupt(overrides: Partial<OpenInterruptRecord> = {}): OpenInterruptRecord {
  return {
    threadId: "thread-1",
    scopeId: "scope-1",
    interruptedRunId: "run-0",
    interruptId: "interrupt-1",
    reason: "elicit",
    toolCallId: "call-1",
    toolName: "book_flight",
    status: "open",
    ...overrides,
  } as OpenInterruptRecord;
}

function body(overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
  return { messages: [], ...overrides };
}

const base = {
  method: "POST",
  threadId: "thread-1",
  runId: "run-1",
  toolRuntimeId: "program-runtime",
};

describe("planTurn", () => {
  it("supersedes an open interrupted turn on a free-form user message", () => {
    const plan = planTurn({
      ...base,
      body: body({ messages: [{ id: "user:1", role: "user", content: "never mind" }] }),
      openInterrupts: [openInterrupt()],
    });

    expect(plan.supersedeOpenProgramTurn).toBe(true);
    expect(plan.effectivePluginAbort).toEqual({
      sessionId: "call-1",
      reason: "superseded_by_user_message",
    });
    // Supersession must not validate resume or resume tool business logic.
    expect(plan.resumeValidation).toBeNull();
    expect(plan.effectiveElicitResponses).toEqual([]);
  });

  it("does not supersede when the request carries elicit responses", () => {
    const responses = [
      {
        sessionId: "call-1",
        callId: "call-1",
        elicitId: "interrupt-1",
        completion: { action: "accept" as const, content: { seat: "3A" } },
      },
    ];
    const plan = planTurn({
      ...base,
      body: body({
        messages: [{ id: "user:1", role: "user", content: "3A" }],
        elicitResponses: responses,
      }),
      openInterrupts: [openInterrupt()],
    });

    expect(plan.supersedeOpenProgramTurn).toBe(false);
    expect(plan.effectivePluginAbort).toBeUndefined();
    expect(plan.effectiveElicitResponses).toEqual(responses);
  });

  it("does not supersede without a user message", () => {
    const plan = planTurn({
      ...base,
      body: body(),
      openInterrupts: [openInterrupt()],
    });
    expect(plan.supersedeOpenProgramTurn).toBe(false);
    expect(plan.effectivePluginAbort).toBeUndefined();
  });

  it("an explicit pluginAbort wins and suppresses resume validation", () => {
    const plan = planTurn({
      ...base,
      body: body({
        pluginAbort: { reason: "cancelled_by_user" },
        resume: [{ interruptId: "interrupt-1", status: "resolved", payload: { ok: true } }],
      }),
      openInterrupts: [openInterrupt()],
    });
    expect(plan.effectivePluginAbort).toEqual({ reason: "cancelled_by_user" });
    expect(plan.resumeValidation).toBeNull();
  });

  it("rejects resume entries whose scope cannot be determined", () => {
    const plan = planTurn({
      ...base,
      body: body({
        resume: [{ interruptId: "unknown-interrupt", status: "resolved", payload: {} }],
      }),
      // No open interrupts and no parentRunId: scope is underivable.
      openInterrupts: [],
    });
    expect(plan.resumeValidation).toEqual({
      ok: false,
      code: "INVALID_RESUME",
      message: "Unable to determine resume scope",
    });
    expect(plan.effectiveElicitResponses).toEqual([]);
  });

  it("suppresses initialToolChoice when responses continue a parked turn", () => {
    const responses = [
      {
        sessionId: "call-1",
        callId: "call-1",
        elicitId: "interrupt-1",
        completion: { action: "cancel" as const },
      },
    ];
    const withResponses = planTurn({
      ...base,
      body: body({ elicitResponses: responses, initialToolChoice: "required" }),
      openInterrupts: [openInterrupt()],
    });
    expect(withResponses.initialToolChoice).toBeUndefined();

    const withoutResponses = planTurn({
      ...base,
      body: body({ initialToolChoice: "required" }),
      openInterrupts: [],
    });
    expect(withoutResponses.initialToolChoice).toBe("required");
  });

  it("prefers the interrupt toolCallId for the supersession abort target", () => {
    const { toolCallId: _omitted, ...interruptWithoutToolCallId } = openInterrupt();
    const plan = planTurn({
      ...base,
      body: body({ messages: [{ id: "user:1", role: "user", content: "stop" }] }),
      openInterrupts: [interruptWithoutToolCallId],
    });
    expect(plan.effectivePluginAbort?.sessionId).toBe("interrupt-1");
  });
});
