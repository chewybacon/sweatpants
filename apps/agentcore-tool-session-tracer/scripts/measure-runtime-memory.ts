import crypto from "node:crypto";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { PROTOCOL_VERSION, type RuntimeRequest, type RuntimeResponse } from "../src/protocol.ts";

const runtimeArn = process.env["AGENTCORE_RUNTIME_ARN"];
if (!runtimeArn) {
  throw new Error("AGENTCORE_RUNTIME_ARN is required");
}
const region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
const qualifier = process.env["AGENTCORE_QUALIFIER"] ?? "DEFAULT";
const client = new BedrockAgentCoreClient({ region });

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
      // ignore non-json data lines
    }
  }
  return responses;
}

async function invoke(
  runtimeSessionId: string,
  payload: RuntimeRequest,
): Promise<RuntimeResponse[]> {
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      qualifier,
      runtimeSessionId,
      payload: Buffer.from(JSON.stringify(payload)),
      contentType: "application/json",
      accept: "text/event-stream",
    }),
  );
  return parseSse(await bodyToString(response.response));
}

async function stop(runtimeSessionId: string): Promise<void> {
  await client
    .send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: runtimeArn,
        qualifier,
        runtimeSessionId,
        clientToken: crypto.randomUUID(),
      }),
    )
    .catch((error) => {
      console.error(
        `stopRuntimeSession failed for ${runtimeSessionId}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
}

function mb(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function status(responses: RuntimeResponse[]): RuntimeResponse | undefined {
  return responses.find((response) => response.type === "session_status");
}

function diagnostics(responses: RuntimeResponse[]) {
  const response = responses.find((item) => item.type === "runtime_diagnostics");
  if (!response || response.type !== "runtime_diagnostics") {
    throw new Error("missing runtime diagnostics response");
  }
  return response.diagnostics;
}

async function diag(runtimeSessionId: string, label: string) {
  const d = diagnostics(
    await invoke(runtimeSessionId, {
      op: "runtime_diagnostics",
      protocolVersion: PROTOCOL_VERSION,
      commandId: `diag-${label}-${Date.now()}`,
      toolSessionId: `diag-${label}`,
    }),
  );
  const memory = d.process.memory;
  console.log(
    JSON.stringify(
      {
        label,
        runtimeSessionId,
        pid: d.process.pid,
        uptimeSeconds: Number(d.process.uptimeSeconds.toFixed(3)),
        rss: mb(memory.rss),
        heapUsed: mb(memory.heapUsed),
        heapTotal: mb(memory.heapTotal),
        external: mb(memory.external),
        cgroupVersion: d.cgroup.version,
        cgroupCurrent: mb(d.cgroup.memoryCurrentBytes),
        cgroupPeak: mb(d.cgroup.memoryPeakBytes),
        cgroupMax:
          typeof d.cgroup.memoryMaxBytes === "number"
            ? mb(d.cgroup.memoryMaxBytes)
            : (d.cgroup.memoryMaxBytes ?? "n/a"),
        sessions: d.sessions,
      },
      null,
      2,
    ),
  );
  return d;
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ runtimeArn, region, qualifier }, null, 2));

  const completedRuntimeSessionId = `mem-completed-${crypto.randomUUID()}`;
  const completedToolSessionId = `simple-${crypto.randomUUID()}`;

  console.log("\n=== completed tool session experiment ===");
  await diag(completedRuntimeSessionId, "completed-baseline");
  const completedStart = await invoke(completedRuntimeSessionId, {
    op: "start_tool_session",
    protocolVersion: PROTOCOL_VERSION,
    commandId: "completed-start",
    toolSessionId: completedToolSessionId,
    toolName: "simple_result",
    params: { measure: true },
  });
  console.log(
    "completed start response types:",
    completedStart
      .map((response) =>
        response.type === "tool_event" ? `${response.type}:${response.event.type}` : response.type,
      )
      .join(", "),
  );
  const completedInspect = await invoke(completedRuntimeSessionId, {
    op: "inspect_tool_session",
    protocolVersion: PROTOCOL_VERSION,
    commandId: "completed-inspect",
    toolSessionId: completedToolSessionId,
  });
  console.log("completed inspect:", JSON.stringify(status(completedInspect), null, 2));
  await diag(completedRuntimeSessionId, "completed-after-inspect");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const completedInspectAfterWait = await invoke(completedRuntimeSessionId, {
    op: "inspect_tool_session",
    protocolVersion: PROTOCOL_VERSION,
    commandId: "completed-inspect-after-wait",
    toolSessionId: completedToolSessionId,
  });
  console.log(
    "completed inspect after 10s:",
    JSON.stringify(status(completedInspectAfterWait), null, 2),
  );
  await diag(completedRuntimeSessionId, "completed-after-10s");

  const idleRuntimeSessionId = `mem-idle-${crypto.randomUUID()}`;
  const idleToolSessionId = `idle-${crypto.randomUUID()}`;

  console.log("\n=== idle/paused tool session experiment ===");
  await diag(idleRuntimeSessionId, "idle-baseline");
  const idleStart = await invoke(idleRuntimeSessionId, {
    op: "start_tool_session",
    protocolVersion: PROTOCOL_VERSION,
    commandId: "idle-start",
    toolSessionId: idleToolSessionId,
    toolName: "elicit_then_result",
    params: { measure: true },
  });
  console.log(
    "idle start response types:",
    idleStart
      .map((response) =>
        response.type === "tool_event" ? `${response.type}:${response.event.type}` : response.type,
      )
      .join(", "),
  );
  console.log("idle status:", JSON.stringify(status(idleStart), null, 2));
  await diag(idleRuntimeSessionId, "idle-after-start");
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  const idleInspectAfterWait = await invoke(idleRuntimeSessionId, {
    op: "inspect_tool_session",
    protocolVersion: PROTOCOL_VERSION,
    commandId: "idle-inspect-after-30s",
    toolSessionId: idleToolSessionId,
  });
  console.log("idle inspect after 30s:", JSON.stringify(status(idleInspectAfterWait), null, 2));
  await diag(idleRuntimeSessionId, "idle-after-30s");

  console.log("\nStopping runtime sessions to avoid further idle cost...");
  await stop(completedRuntimeSessionId);
  await stop(idleRuntimeSessionId);
  console.log("stopped", { completedRuntimeSessionId, idleRuntimeSessionId });
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
