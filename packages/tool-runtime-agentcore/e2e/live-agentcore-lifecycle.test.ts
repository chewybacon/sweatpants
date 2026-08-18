// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { run } from "effection";
import { z } from "zod";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { createTool } from "@sweatpants/agent-sdk";
import {
  AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION,
  createAgentCoreRemoteToolRuntimeClient,
  createAwsSdkAgentCoreInvoker,
  type AgentCoreToolRuntimeProfile,
} from "../src/index.ts";
import { createAgentCoreToolInvocationResources } from "../src/agentcore-invocation-resources.ts";
import {
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
} from "../src/agentcore-memory-store.ts";
import type { AgentCoreToolSessionStores } from "../src/agentcore-types.ts";

const enabled = process.env["AGENTCORE_LIVE_E2E"] === "yes";
const runtimeArn = process.env["AGENTCORE_RUNTIME_ARN"];
const region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
const endpointName =
  process.env["AGENTCORE_ENDPOINT_NAME"] ?? process.env["AGENTCORE_QUALIFIER"] ?? "DEFAULT";

const liveDescribe = enabled && runtimeArn ? describe.sequential : describe.skip;

const PROTOCOL_VERSION = AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION;

type ToolStatus =
  | "initializing"
  | "running"
  | "awaiting_elicit"
  | "awaiting_sample"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

type RuntimeEvent =
  | { type: "progress"; message: string; progress?: number }
  | { type: "log"; level: "debug" | "info" | "warning" | "error"; message: string }
  | {
      type: "elicit_request";
      elicitId: string;
      key: string;
      message: string;
      schema: Record<string, unknown>;
      context?: Record<string, unknown>;
    }
  | {
      type: "sample_request";
      sampleId: string;
      messages: unknown[];
      systemPrompt?: string;
      maxTokens?: number;
      tools?: unknown[];
      toolChoice?: unknown;
      schema?: Record<string, unknown>;
    }
  | { type: "result"; result: unknown }
  | { type: "error"; name: string; message: string; stack?: string }
  | { type: "cancelled"; reason?: string };

type RuntimeDiagnostics = {
  runtimeSessionId: string;
  process: {
    pid: number;
    uptimeSeconds: number;
    memory: NodeJS.MemoryUsage;
    resourceUsage: NodeJS.ResourceUsage;
  };
  cgroup: {
    version: "v1" | "v2" | "unknown";
    memoryCurrentBytes?: number;
    memoryPeakBytes?: number;
    memoryMaxBytes?: number | "max";
    memoryStat?: Record<string, number>;
  };
  sessions: {
    total: number;
    nonTerminal: number;
    terminal: number;
    byStatus: Record<ToolStatus, number>;
  };
};

type RuntimeResponse =
  | {
      type: "tool_event";
      toolSessionId: string;
      runtimeEventSeq: number;
      runtimeEventId: string;
      event: RuntimeEvent;
    }
  | {
      type: "session_status";
      toolSessionId: string;
      status: ToolStatus;
      pendingRequest?: { type: "elicit"; elicitId: string } | { type: "sample"; sampleId: string };
      lastRuntimeEventSeq: number;
    }
  | { type: "runtime_diagnostics"; toolSessionId: string; diagnostics: RuntimeDiagnostics }
  | { type: "session_not_found"; toolSessionId: string }
  | {
      type: "command_duplicate";
      toolSessionId: string;
      commandId: string;
      originalStatus: "accepted" | "rejected";
    }
  | { type: "command_conflict"; toolSessionId: string; commandId: string; message: string }
  | { type: "protocol_error"; message: string; details?: unknown };

type RuntimeRequest = {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  toolSessionId: string;
} & (
  | {
      op: "start_tool_session";
      toolName: string;
      params?: unknown;
      context?: Record<string, unknown>;
    }
  | {
      op: "respond_to_elicit";
      elicitId: string;
      response: { action: "accept" | "decline" | "cancel"; content?: unknown };
    }
  | {
      op: "respond_to_sample";
      sampleId: string;
      response: {
        text: string;
        model?: string;
        stopReason?: string;
        parsed?: unknown;
        parseError?: unknown;
        toolCalls?: unknown[];
      };
    }
  | { op: "cancel_tool_session"; reason?: string }
  | { op: "inspect_tool_session" }
  | { op: "drain_tool_session_events"; afterRuntimeEventSeq: number }
  | { op: "runtime_diagnostics" }
);

const rawClient = new BedrockAgentCoreClient({ region });
const runtimeSessionsToCleanup = new Set<string>();

const simpleResultTool = createTool("simple_result")
  .description("Live tracer simple result tool")
  .parameters(z.object({ value: z.unknown().optional() }))
  .execute(function* (params) {
    return params;
  });

const elicitThenResultTool = createTool("elicit_then_result")
  .description("Live tracer elicit then result tool")
  .parameters(z.object({ value: z.unknown().optional() }))
  .execute(function* (params) {
    return params;
  });

function liveId(prefix: string): string {
  return `${prefix}-${randomUUID()}`.slice(0, 120);
}

function createStores(): AgentCoreToolSessionStores {
  return {
    handles: createInMemoryAgentCoreToolSessionHandleStore(),
    events: createInMemoryAgentCoreToolSessionEventStore(),
  };
}

function createProfile(toolNames: string[]): AgentCoreToolRuntimeProfile {
  return {
    name: "live-tracer",
    runtimeArn: runtimeArn!,
    endpointName,
    region,
    toolNames,
    maxSessionTtlMs: 10 * 60 * 1000,
  };
}

async function bodyToString(body: unknown): Promise<string> {
  const value = body as
    | {
        transformToString?: () => Promise<string>;
        [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
      }
    | undefined;
  if (!value) {
    return "";
  }
  if (typeof value.transformToString === "function") {
    return await value.transformToString();
  }
  if (typeof value[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of value as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return String(value);
}

function parseSse(raw: string): RuntimeResponse[] {
  const responses: RuntimeResponse[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) {
      continue;
    }

    let text = dataLines.join("\n");
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "string") {
        text = parsed.startsWith("data:") ? parsed.slice(5).trim() : parsed;
      } else if (parsed && typeof parsed === "object" && "data" in parsed) {
        responses.push((parsed as { data: RuntimeResponse }).data);
        continue;
      }
    } catch {
      // keep raw text
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && "data" in parsed) {
        responses.push((parsed as { data: RuntimeResponse }).data);
      } else {
        responses.push(parsed as RuntimeResponse);
      }
    } catch {
      // ignore non-json SSE data lines
    }
  }
  return responses;
}

async function rawInvoke(
  runtimeSessionId: string,
  payload: RuntimeRequest,
): Promise<RuntimeResponse[]> {
  runtimeSessionsToCleanup.add(runtimeSessionId);
  const response = await rawClient.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn!,
      qualifier: endpointName,
      runtimeSessionId,
      payload: Buffer.from(JSON.stringify(payload)),
      contentType: "application/json",
      accept: "text/event-stream",
    }),
  );
  return parseSse(await bodyToString(response.response));
}

async function rawStop(runtimeSessionId: string): Promise<void> {
  try {
    await rawClient.send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: runtimeArn!,
        qualifier: endpointName,
        runtimeSessionId,
        clientToken: randomUUID(),
      }),
    );
  } catch {
    // Cleanup is best-effort. Some tests intentionally stop sessions before
    // afterEach sees them, and AWS may report already-stopped/not-found states.
  }
}

function responseTypes(responses: RuntimeResponse[]): string[] {
  return responses.map((response) =>
    response.type === "tool_event" ? `tool_event:${response.event.type}` : response.type,
  );
}

function statusResponse(
  responses: RuntimeResponse[],
): Extract<RuntimeResponse, { type: "session_status" }> | undefined {
  return responses.find(
    (response): response is Extract<RuntimeResponse, { type: "session_status" }> =>
      response.type === "session_status",
  );
}

function eventResponse<TType extends RuntimeEvent["type"]>(
  responses: RuntimeResponse[],
  type: TType,
): Extract<RuntimeResponse, { type: "tool_event" }> | undefined {
  return responses.find(
    (response): response is Extract<RuntimeResponse, { type: "tool_event" }> =>
      response.type === "tool_event" && response.event.type === type,
  );
}

function diagnosticsResponse(responses: RuntimeResponse[]): RuntimeDiagnostics {
  const response = responses.find(
    (item): item is Extract<RuntimeResponse, { type: "runtime_diagnostics" }> =>
      item.type === "runtime_diagnostics",
  );
  if (!response) {
    throw new Error(
      `Missing runtime_diagnostics response. Received: ${responseTypes(responses).join(", ")}`,
    );
  }
  return response.diagnostics;
}

function baseRequest(commandId: string, toolSessionId: string) {
  return { protocolVersion: PROTOCOL_VERSION, commandId, toolSessionId };
}

async function startSimple(
  runtimeSessionId: string,
  toolSessionId: string,
  commandId = "start-simple",
): Promise<RuntimeResponse[]> {
  return rawInvoke(runtimeSessionId, {
    ...baseRequest(commandId, toolSessionId),
    op: "start_tool_session",
    toolName: "simple_result",
    params: { test: true },
  });
}

async function startElicit(
  runtimeSessionId: string,
  toolSessionId: string,
  commandId = "start-elicit",
): Promise<RuntimeResponse[]> {
  return rawInvoke(runtimeSessionId, {
    ...baseRequest(commandId, toolSessionId),
    op: "start_tool_session",
    toolName: "elicit_then_result",
    params: { test: true },
  });
}

async function inspect(
  runtimeSessionId: string,
  toolSessionId: string,
): Promise<RuntimeResponse[]> {
  return rawInvoke(runtimeSessionId, {
    ...baseRequest(`inspect-${randomUUID()}`, toolSessionId),
    op: "inspect_tool_session",
  });
}

async function diagnostics(runtimeSessionId: string): Promise<RuntimeDiagnostics> {
  return diagnosticsResponse(
    await rawInvoke(runtimeSessionId, {
      ...baseRequest(`diag-${randomUUID()}`, `diag-${randomUUID()}`),
      op: "runtime_diagnostics",
    }),
  );
}

async function assertOldToolStateGone(
  runtimeSessionId: string,
  toolSessionId: string,
): Promise<void> {
  let lastObserved = "not-polled";
  await expect
    .poll(
      async () => {
        try {
          const responses = await inspect(runtimeSessionId, toolSessionId);
          const status = statusResponse(responses);
          if (status?.toolSessionId === toolSessionId) {
            lastObserved = `status:${status.status}`;
            return "old-state-present";
          }
          if (
            responses.some(
              (response) =>
                response.type === "session_not_found" && response.toolSessionId === toolSessionId,
            )
          ) {
            return "old-state-gone";
          }
          lastObserved = responseTypes(responses).join(",");
          return "old-state-gone";
        } catch (error) {
          lastObserved = error instanceof Error ? `${error.name}:${error.message}` : String(error);
          return "old-state-gone";
        }
      },
      {
        message: `expected stopped runtime session ${runtimeSessionId} not to expose old tool session ${toolSessionId}; last observed ${lastObserved}`,
        timeout: 60_000,
        interval: 5_000,
      },
    )
    .toBe("old-state-gone");
}

beforeAll(() => {
  if (!enabled) {
    console.warn("Skipping AgentCore live e2e because AGENTCORE_LIVE_E2E=yes is not set");
    return;
  }
  if (!runtimeArn) {
    console.warn("Skipping AgentCore live e2e because AGENTCORE_RUNTIME_ARN is not set");
    return;
  }
  console.warn(
    `Running live AgentCore e2e against ${runtimeArn} endpoint=${endpointName} region=${region}`,
  );
});

afterEach(async () => {
  const ids = [...runtimeSessionsToCleanup];
  runtimeSessionsToCleanup.clear();
  await Promise.all(ids.map(rawStop));
});

liveDescribe("AgentCore live runtime lifecycle contract", () => {
  it("exposes diagnostics with process/cgroup memory and zero sessions on a fresh runtime session", async () => {
    const runtimeSessionId = liveId("live-diag");

    const diag = await diagnostics(runtimeSessionId);

    expect(diag.runtimeSessionId).toBe(runtimeSessionId);
    expect(diag.process.pid).toBeGreaterThan(0);
    expect(diag.process.memory.rss).toBeGreaterThan(0);
    expect(diag.process.memory.heapUsed).toBeGreaterThan(0);
    expect(diag.cgroup.version).not.toBe("unknown");
    expect(diag.cgroup.memoryCurrentBytes ?? 0).toBeGreaterThan(0);
    expect(diag.sessions).toMatchObject({ total: 0, nonTerminal: 0, terminal: 0 });
  });

  it("raw completed tool sessions remain inspectable until StopRuntimeSession is called", async () => {
    const runtimeSessionId = liveId("live-raw-complete");
    const toolSessionId = liveId("tool-simple");

    const start = await startSimple(runtimeSessionId, toolSessionId);
    expect(responseTypes(start)).toContain("tool_event:result");
    expect(statusResponse(start)).toMatchObject({ toolSessionId, status: "completed" });

    const inspectBeforeStop = await inspect(runtimeSessionId, toolSessionId);
    expect(statusResponse(inspectBeforeStop)).toMatchObject({ toolSessionId, status: "completed" });

    const diagBeforeStop = await diagnostics(runtimeSessionId);
    expect(diagBeforeStop.sessions.total).toBeGreaterThanOrEqual(1);
    expect(diagBeforeStop.sessions.terminal).toBeGreaterThanOrEqual(1);
    expect(diagBeforeStop.sessions.byStatus.completed).toBeGreaterThanOrEqual(1);

    await rawStop(runtimeSessionId);
    await assertOldToolStateGone(runtimeSessionId, toolSessionId);
  });

  it("the package adapter stops AgentCore runtime sessions after immediate terminal completion", async () => {
    const runtimeSessionId = liveId("live-adapter-complete");
    const toolSessionId = liveId("tool-adapter-simple");
    runtimeSessionsToCleanup.add(runtimeSessionId);

    const stores = createStores();
    const runtimeClient = createAgentCoreRemoteToolRuntimeClient(
      createAwsSdkAgentCoreInvoker({ clientConfig: { region } }),
    );
    const resources = createAgentCoreToolInvocationResources({
      stores,
      runtimeClient,
      profiles: [createProfile(["simple_result"])],
      createRuntimeSessionId: () => runtimeSessionId,
    });

    const result = await run(function* () {
      const session = yield* resources.create(
        simpleResultTool,
        { value: "ok" },
        { sessionId: toolSessionId },
      );
      return {
        status: yield* session.status(),
        handle: yield* stores.handles.get(toolSessionId),
        events: yield* stores.events.readAfter(toolSessionId, 0),
      };
    });

    expect(result.status).toBe("completed");
    expect(result.events.events.map(({ event }) => event.type)).toEqual(["progress", "result"]);
    expect(result.handle).toMatchObject({
      sessionId: toolSessionId,
      runtimeSessionId,
      status: "completed",
      stopRequestedAt: expect.any(String),
      stoppedAt: expect.any(String),
    });

    await assertOldToolStateGone(runtimeSessionId, toolSessionId);
  });

  it("the package adapter keeps paused sessions alive, then stops after resumed terminal completion", async () => {
    const runtimeSessionId = liveId("live-adapter-elicit");
    const toolSessionId = liveId("tool-adapter-elicit");
    runtimeSessionsToCleanup.add(runtimeSessionId);

    const stores = createStores();
    const runtimeClient = createAgentCoreRemoteToolRuntimeClient(
      createAwsSdkAgentCoreInvoker({ clientConfig: { region } }),
    );
    const resources = createAgentCoreToolInvocationResources({
      stores,
      runtimeClient,
      profiles: [createProfile(["elicit_then_result"])],
      createRuntimeSessionId: () => runtimeSessionId,
    });

    const afterStart = await run(function* () {
      const session = yield* resources.create(
        elicitThenResultTool,
        { value: "pause" },
        { sessionId: toolSessionId },
      );
      const status = yield* session.status();
      const handle = yield* stores.handles.get(toolSessionId);
      return { session, status, handle };
    });

    expect(afterStart.status).toBe("awaiting_elicit");
    expect(afterStart.handle?.pendingRequest).toMatchObject({ type: "elicit" });
    expect(afterStart.handle?.stopRequestedAt).toBeUndefined();
    expect(afterStart.handle?.stoppedAt).toBeUndefined();

    const diagWhilePaused = await diagnostics(runtimeSessionId);
    expect(diagWhilePaused.sessions.total).toBeGreaterThanOrEqual(1);
    expect(diagWhilePaused.sessions.nonTerminal).toBeGreaterThanOrEqual(1);
    expect(diagWhilePaused.sessions.byStatus.awaiting_elicit).toBeGreaterThanOrEqual(1);

    const pending = afterStart.handle?.pendingRequest;
    if (!pending || pending.type !== "elicit") {
      throw new Error("expected pending elicit request");
    }

    const afterResume = await run(function* () {
      yield* afterStart.session.resume({
        kind: "elicit",
        requestId: pending.elicitId,
        response: { action: "accept", content: { confirmed: true } },
      });
      return {
        status: yield* afterStart.session.status(),
        handle: yield* stores.handles.get(toolSessionId),
        events: yield* stores.events.readAfter(toolSessionId, 0),
      };
    });

    expect(afterResume.status).toBe("completed");
    const resumedEventTypes = afterResume.events.events.map(({ event }) => event.type);
    expect(resumedEventTypes.slice(0, 2)).toEqual(["progress", "elicit_request"]);
    expect(resumedEventTypes).toContain("result");
    expect(resumedEventTypes.indexOf("result")).toBeGreaterThan(
      resumedEventTypes.indexOf("elicit_request"),
    );
    expect(afterResume.handle).toMatchObject({
      sessionId: toolSessionId,
      runtimeSessionId,
      status: "completed",
      stopRequestedAt: expect.any(String),
      stoppedAt: expect.any(String),
    });

    await assertOldToolStateGone(runtimeSessionId, toolSessionId);
  });

  it("isolates identical toolSessionIds by AgentCore runtimeSessionId", async () => {
    const ownedRuntimeSessionId = liveId("live-owned");
    const wrongRuntimeSessionId = liveId("live-wrong");
    const sharedToolSessionId = liveId("tool-shared");

    const start = await startElicit(ownedRuntimeSessionId, sharedToolSessionId);
    const elicit = eventResponse(start, "elicit_request");
    expect(elicit?.event).toMatchObject({ type: "elicit_request" });
    expect(statusResponse(start)).toMatchObject({
      toolSessionId: sharedToolSessionId,
      status: "awaiting_elicit",
    });

    const wrongInspect = await inspect(wrongRuntimeSessionId, sharedToolSessionId);
    expect(wrongInspect).toContainEqual({
      type: "session_not_found",
      toolSessionId: sharedToolSessionId,
    });

    const ownerInspect = await inspect(ownedRuntimeSessionId, sharedToolSessionId);
    expect(statusResponse(ownerInspect)).toMatchObject({
      toolSessionId: sharedToolSessionId,
      status: "awaiting_elicit",
    });
  });

  it("implements start command idempotency and conflicting reuse protection", async () => {
    const runtimeSessionId = liveId("live-duplicate");
    const toolSessionId = liveId("tool-duplicate");
    const commandId = "same-start-command";

    const first = await startSimple(runtimeSessionId, toolSessionId, commandId);
    expect(statusResponse(first)).toMatchObject({ toolSessionId, status: "completed" });

    const duplicate = await startSimple(runtimeSessionId, toolSessionId, commandId);
    expect(duplicate[0]).toMatchObject({ type: "command_duplicate", toolSessionId, commandId });
    expect(statusResponse(duplicate)).toMatchObject({ toolSessionId, status: "completed" });

    const conflict = await rawInvoke(runtimeSessionId, {
      ...baseRequest("different-start-command", toolSessionId),
      op: "start_tool_session",
      toolName: "simple_result",
      params: { test: false, changed: true },
    });
    expect(conflict).toContainEqual({
      type: "command_conflict",
      toolSessionId,
      commandId: "different-start-command",
      message: "toolSessionId already exists with different start command",
    });
  });
});
