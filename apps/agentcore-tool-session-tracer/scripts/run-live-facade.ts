import crypto from "node:crypto";
import { call, run } from "effection";
import { createAwsSdkAgentCoreInvoker } from "@sweatpants/tool-runtime-agentcore";
import { ToolInvocationHostPort } from "@sweatpants/tool-session";
import { createAgentCoreRemoteToolRuntimeClient } from "@sweatpants/tool-runtime-agentcore";
import { createAgentCoreToolInvocationRuntime } from "@sweatpants/tool-runtime-agentcore";
import type { AgentCoreToolRuntimeProfile } from "@sweatpants/tool-runtime-agentcore";

const runtimeArnEnv = process.env["AGENTCORE_RUNTIME_ARN"];
if (!runtimeArnEnv) {
  throw new Error("AGENTCORE_RUNTIME_ARN is required");
}
const runtimeArn: string = runtimeArnEnv;

const region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const elicitTool = { name: "elicit_then_result" } as never;

async function main(): Promise<void> {
  const runtimeClient = createAgentCoreRemoteToolRuntimeClient(
    createAwsSdkAgentCoreInvoker({ clientConfig: { region } }),
  );
  const profile: AgentCoreToolRuntimeProfile = {
    name: "live-tracer",
    runtimeArn,
    endpointName: process.env["AGENTCORE_QUALIFIER"] ?? "DEFAULT",
    region,
    toolNames: ["elicit_then_result"],
    maxSessionTtlMs: 15 * 60 * 1000,
  };
  const runtimeSessionId =
    process.env["AGENTCORE_SESSION_ID"] ?? `sp-facade-${crypto.randomUUID()}`;
  const toolSessionId = process.env["TOOL_SESSION_ID"] ?? `facade-tool-${crypto.randomUUID()}`;

  const summary = await run(function* () {
    yield* createAgentCoreToolInvocationRuntime({
      runtimeClient,
      profiles: [profile],
      createRuntimeSessionId: () => runtimeSessionId,
    });
    const host = yield* ToolInvocationHostPort.use();
    yield* host.start({ invocationId: toolSessionId, tool: elicitTool, input: {} });
    const initial = yield* host.turn({
      invocationId: toolSessionId,
      commandId: `call:${toolSessionId}:start`,
      cursor: 0,
    });
    assert(initial.type === "parked", `expected parked, got ${initial.type}`);
    const statusBefore = "awaiting_elicit";

    assert(initial.ask.kind === "elicit", "missing pending elicitation");
    const elicitId = initial.ask.requestId;

    const delayMs = Number(process.env["AGENTCORE_FACADE_DELAY_MS"] ?? "60000");
    yield* call(() => new Promise((resolve) => setTimeout(resolve, delayMs)));

    const terminal = yield* host.turn({
      invocationId: toolSessionId,
      commandId: `elicit:${elicitId}`,
      cursor: initial.cursor,
      resume: {
        kind: "elicit",
        requestId: elicitId,
        response: {
          action: "accept",
          content: { confirmed: true, via: "sweatpants-facade" },
        },
      },
    });
    assert(terminal.type === "completed", `expected completed, got ${terminal.type}`);
    const statusAfter = "completed";

    return {
      status: "ok",
      runtimeArn,
      region,
      runtimeSessionId,
      toolSessionId,
      delayMs,
      statusBefore,
      statusAfter,
      result: terminal.result,
    };
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
