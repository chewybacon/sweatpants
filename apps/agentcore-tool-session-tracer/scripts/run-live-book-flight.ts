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

const bookFlightTool = { name: "book_flight" } as never;

async function main(): Promise<void> {
  const runtimeClient = createAgentCoreRemoteToolRuntimeClient(
    createAwsSdkAgentCoreInvoker({ clientConfig: { region } }),
  );
  const profile: AgentCoreToolRuntimeProfile = {
    name: "live-book-flight",
    runtimeArn,
    endpointName: process.env["AGENTCORE_QUALIFIER"] ?? "DEFAULT",
    region,
    toolNames: ["book_flight"],
    maxSessionTtlMs: 15 * 60 * 1000,
  };
  const runtimeSessionId =
    process.env["AGENTCORE_SESSION_ID"] ?? `sp-book-flight-${crypto.randomUUID()}`;
  const toolSessionId = process.env["TOOL_SESSION_ID"] ?? `book-flight-${crypto.randomUUID()}`;

  const summary = await run(function* () {
    yield* createAgentCoreToolInvocationRuntime({
      runtimeClient,
      profiles: [profile],
      createRuntimeSessionId: () => runtimeSessionId,
    });
    const host = yield* ToolInvocationHostPort.use();
    yield* host.start({
      invocationId: toolSessionId,
      tool: bookFlightTool,
      input: { from: "NYC", destination: "LAX" },
    });
    const firstTurn = yield* host.turn({
      invocationId: toolSessionId,
      commandId: `call:${toolSessionId}:start`,
      cursor: 0,
    });
    assert(firstTurn.type === "parked", "expected first parked turn");

    assert(
      firstTurn.ask.kind === "elicit" && firstTurn.ask.key === "pickFlight",
      "missing pickFlight elicit",
    );
    const pickFlight = firstTurn.ask;

    yield* call(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, Number(process.env["AGENTCORE_BOOK_FLIGHT_TURN_DELAY_MS"] ?? "1000")),
        ),
    );
    const secondTurn = yield* host.turn({
      invocationId: toolSessionId,
      commandId: `elicit:${pickFlight.requestId}`,
      cursor: firstTurn.cursor,
      resume: {
        kind: "elicit",
        requestId: pickFlight.requestId,
        response: {
          action: "accept",
          content: { flightId: "FL001" },
        },
      },
    });
    assert(secondTurn.type === "parked", "expected second parked turn");

    assert(
      secondTurn.ask.kind === "elicit" && secondTurn.ask.key === "pickSeat",
      "missing pickSeat elicit",
    );
    const pickSeat = secondTurn.ask;

    yield* call(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, Number(process.env["AGENTCORE_BOOK_FLIGHT_TURN_DELAY_MS"] ?? "1000")),
        ),
    );
    const sampleTurn = yield* host.turn({
      invocationId: toolSessionId,
      commandId: `elicit:${pickSeat.requestId}`,
      cursor: secondTurn.cursor,
      resume: {
        kind: "elicit",
        requestId: pickSeat.requestId,
        response: {
          action: "accept",
          content: { row: 3, seat: "A" },
        },
      },
    });
    assert(sampleTurn.type === "parked", "expected sample turn");

    assert(sampleTurn.ask.kind === "sample", "missing sample request");
    const sample = sampleTurn.ask;

    yield* call(
      () =>
        new Promise((resolve) =>
          setTimeout(resolve, Number(process.env["AGENTCORE_BOOK_FLIGHT_TURN_DELAY_MS"] ?? "1000")),
        ),
    );
    const terminal = yield* host.turn({
      invocationId: toolSessionId,
      commandId: `sample:${sample.requestId}`,
      cursor: sampleTurn.cursor,
      resume: {
        kind: "sample",
        requestId: sample.requestId,
        response: {
          text: "Use the rideshare pickup zone on the arrivals level.",
        },
      },
    });
    assert(terminal.type === "completed", "expected completed");

    const booking = terminal.result as {
      success?: boolean;
      seat?: string;
      travelTip?: string;
      flight?: { id?: string };
      ticketNumber?: string;
    };
    assert(booking.success === true, "booking did not succeed");
    assert(booking.flight?.id === "FL001", "flight mismatch");
    assert(booking.seat === "3A", "seat mismatch");
    assert(
      booking.travelTip === "Use the rideshare pickup zone on the arrivals level.",
      "travel tip mismatch",
    );

    return {
      status: "ok",
      runtimeArn,
      region,
      runtimeSessionId,
      toolSessionId,
      elicitKeys: [pickFlight.key, pickSeat.key],
      result: booking,
    };
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
