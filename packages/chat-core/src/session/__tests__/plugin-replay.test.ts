import { describe, expect, it } from "vitest";

import {
  buildPluginReplayActivity,
  mergePluginReplayTrace,
  normalizeClientReplayTrace,
  PLUGIN_REPLAY_ACTIVITY_TYPE,
  PLUGIN_REPLAY_LIMITS,
} from "../plugin-replay.ts";
import type { ToolExecutionTrace } from "@sweatpants/chat-core";

function trace(interruptId: string, emissionId: string, timestamp: number): ToolExecutionTrace {
  return {
    version: 1,
    startedAt: timestamp,
    completedAt: timestamp + 1,
    emissions: [
      {
        order: 99,
        emissionId,
        sourceInterruptId: interruptId,
        componentKey: "FlightList",
        props: { flights: [{ id: "FL001" }] },
        response: { flightId: "FL001" },
        timestamp,
      },
    ],
  };
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index++) {
    value = { child: value };
  }
  return value;
}

describe("plugin replay helper", () => {
  it("normalizes trace order from array position and preserves stable identity", () => {
    const normalized = normalizeClientReplayTrace(
      {
        version: 1,
        startedAt: 1,
        completedAt: 2,
        emissions: [
          {
            order: 10,
            emissionId: "em-a",
            componentKey: "A",
            props: { ok: true },
            timestamp: 1000,
          },
          {
            order: 0,
            emissionId: "em-b",
            componentKey: "B",
            props: { ok: true },
            timestamp: 800,
          },
        ],
      },
      { interruptId: "interrupt-1" },
    );

    expect(normalized?.emissions.map((entry) => entry.order)).toEqual([0, 1]);
    expect(normalized?.emissions.map((entry) => entry.emissionId)).toEqual(["em-a", "em-b"]);
    expect(normalized?.emissions.map((entry) => entry.sourceInterruptId)).toEqual([
      "interrupt-1",
      "interrupt-1",
    ]);
  });

  it("deduplicates duplicate interrupt/emission keys and replaces in place", () => {
    const first = mergePluginReplayTrace(undefined, {
      threadId: "thread",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "bookFlight",
      interruptId: "interrupt-1",
      trace: trace("interrupt-1", "em-1", 1000),
    });

    const duplicate = trace("interrupt-1", "em-1", 900);
    duplicate.emissions[0] = {
      ...duplicate.emissions[0]!,
      response: { flightId: "FL002" },
    };

    const merged = mergePluginReplayTrace(first, {
      threadId: "thread",
      runId: "run-2",
      toolCallId: "call-1",
      toolName: "bookFlight",
      interruptId: "interrupt-1",
      trace: duplicate,
    });

    expect(merged.emissions).toHaveLength(1);
    expect(merged.emissions[0]?.order).toBe(0);
    expect(merged.emissions[0]?.response).toEqual({ flightId: "FL002" });
  });

  it("preserves distinct interrupt traces for the same tool call in arrival order", () => {
    const first = mergePluginReplayTrace(undefined, {
      threadId: "thread",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "bookFlight",
      interruptId: "interrupt-1",
      trace: trace("interrupt-1", "em-1", 1000),
    });

    const second = mergePluginReplayTrace(first, {
      threadId: "thread",
      runId: "run-2",
      toolCallId: "call-1",
      toolName: "bookFlight",
      interruptId: "interrupt-2",
      trace: trace("interrupt-2", "em-2", 800),
    });

    expect(second.emissions.map((entry) => entry.emissionId)).toEqual(["em-1", "em-2"]);
    expect(second.emissions.map((entry) => entry.order)).toEqual([0, 1]);
  });

  it("builds a stable replacing activity snapshot", () => {
    const activity = buildPluginReplayActivity({
      toolCallId: "call-1",
      toolName: "bookFlight",
      trace: trace("interrupt-1", "em-1", 1000),
    });

    expect(activity).toMatchObject({
      type: "ACTIVITY_SNAPSHOT",
      messageId: "sweatpants:plugin-replay:call-1",
      activityType: PLUGIN_REPLAY_ACTIVITY_TYPE,
      replace: true,
    });
    expect(activity?.content.trace.emissions[0]?.order).toBe(0);
  });

  it("deduplicates partially upgraded traces by interrupt id plus original order", () => {
    // SAFETY: intentionally models a partially upgraded persisted trace whose
    // emission predates stable emissionId assignment.
    const incoming = {
      version: 1,
      startedAt: 1,
      completedAt: 2,
      emissions: [
        {
          order: 0,
          sourceInterruptId: "interrupt-1",
          componentKey: "FlightList",
          props: { ok: true },
          response: { accepted: true },
          timestamp: 1000,
        },
      ],
    } as unknown as ToolExecutionTrace;

    const first = mergePluginReplayTrace(undefined, {
      threadId: "thread",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "bookFlight",
      interruptId: "interrupt-1",
      trace: incoming,
    });

    const duplicate = mergePluginReplayTrace(first, {
      threadId: "thread",
      runId: "run-2",
      toolCallId: "call-1",
      toolName: "bookFlight",
      interruptId: "interrupt-1",
      trace: {
        ...incoming,
        emissions: [{ ...incoming.emissions[0]!, response: { accepted: false } }],
      },
    });

    expect(duplicate.emissions).toHaveLength(1);
    expect(duplicate.emissions[0]?.order).toBe(0);
    expect(duplicate.emissions[0]?.response).toEqual({ accepted: false });
  });

  it("rejects traces without the closed version and stable emission ids", () => {
    const invalidTrace = {
      startedAt: 1,
      completedAt: 2,
      emissions: [
        {
          order: 42,
          componentKey: "OldCard",
          props: { ok: true },
          response: { picked: "A" },
          timestamp: 1000,
        },
      ],
    };

    expect(
      buildPluginReplayActivity({
        toolCallId: "old-call",
        toolName: "oldTool",
        // SAFETY: malformed boundary input is the subject of this test.
        trace: invalidTrace as unknown as ToolExecutionTrace,
      }),
    ).toBeNull();
  });

  it("enforces exact incoming emission and JSON-depth trace boundaries", () => {
    const atEmissionLimit = normalizeClientReplayTrace({
      version: 1,
      startedAt: 1,
      completedAt: 2,
      emissions: Array.from(
        { length: PLUGIN_REPLAY_LIMITS.maxIncomingTraceEmissions },
        (_, index) => ({
          emissionId: `em-${index}`,
          componentKey: "A",
          props: {},
          timestamp: index,
        }),
      ),
    });
    expect(atEmissionLimit?.emissions).toHaveLength(PLUGIN_REPLAY_LIMITS.maxIncomingTraceEmissions);

    const overEmissionLimit = normalizeClientReplayTrace({
      version: 1,
      startedAt: 1,
      completedAt: 2,
      emissions: Array.from(
        { length: PLUGIN_REPLAY_LIMITS.maxIncomingTraceEmissions + 1 },
        (_, index) => ({
          emissionId: `em-${index}`,
          componentKey: "A",
          props: {},
          timestamp: index,
        }),
      ),
    });
    expect(overEmissionLimit).toBeNull();

    expect(
      normalizeClientReplayTrace({
        version: 1,
        startedAt: 1,
        completedAt: 2,
        emissions: [
          { emissionId: "em-depth-ok", componentKey: "A", props: nestedObject(19), timestamp: 1 },
        ],
      }),
    ).not.toBeNull();

    expect(
      normalizeClientReplayTrace({
        version: 1,
        startedAt: 1,
        completedAt: 2,
        emissions: [
          { emissionId: "em-depth-bad", componentKey: "A", props: nestedObject(20), timestamp: 1 },
        ],
      }),
    ).toBeNull();
  });

  it("caps merged emissions per tool call and rejects over-size activity content", () => {
    const oversizedIncoming: ToolExecutionTrace = {
      version: 1,
      startedAt: 1,
      completedAt: 2,
      emissions: Array.from(
        { length: PLUGIN_REPLAY_LIMITS.maxMergedTraceEmissionsPerToolCall + 1 },
        (_, index) => ({
          order: index,
          emissionId: `em-${index}`,
          sourceInterruptId: `interrupt-${index}`,
          componentKey: "A",
          props: {},
          timestamp: index,
        }),
      ),
    };

    const merged = mergePluginReplayTrace(undefined, {
      threadId: "thread",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "tool",
      trace: oversizedIncoming,
    });
    expect(merged.emissions).toHaveLength(PLUGIN_REPLAY_LIMITS.maxMergedTraceEmissionsPerToolCall);
    expect(merged.emissions.map((entry) => entry.order)).toEqual(
      Array.from(
        { length: PLUGIN_REPLAY_LIMITS.maxMergedTraceEmissionsPerToolCall },
        (_, index) => index,
      ),
    );

    const tooLargeActivity = buildPluginReplayActivity({
      toolCallId: "call-large",
      toolName: "tool",
      trace: {
        version: 1,
        startedAt: 1,
        completedAt: 2,
        emissions: [
          {
            order: 0,
            emissionId: "em-large",
            sourceInterruptId: "interrupt-large",
            componentKey: "Large",
            props: { data: "x".repeat(PLUGIN_REPLAY_LIMITS.maxMergedActivityContentBytes) },
            timestamp: 1,
          },
        ],
      },
    });
    expect(tooLargeActivity).toBeNull();
  });

  it("rejects non-json traces without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(
      normalizeClientReplayTrace({
        version: 1,
        startedAt: 1,
        completedAt: 2,
        emissions: [
          {
            emissionId: "em-1",
            componentKey: "A",
            props: circular,
            timestamp: 1,
          },
        ],
      }),
    ).toBeNull();
  });
});
