import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  withTestScenario,
  type TestApplication,
  type TestApplicationFactoryContext,
} from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "../lib/acceptance-app.ts";

const LIVE_STREAM_AFTER_FIRST_TEXT = "live-stream-after-first-text";
const AUTHORITY_STREAM_COMPLETED = "authority-stream-completed";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  completed: Deferred,
): Promise<void> {
  try {
    while (!(await reader.read()).done) {
      // The Host-owned turn must keep publishing after the client-side fault.
    }
    completed.resolve();
  } catch {
    // The injected consumer failure is the assertion target, not drain cleanup.
  }
}

function failAfterFirstTextDelta(
  response: Response,
  reached: Deferred,
  release: Deferred,
  completed: Deferred,
): Response {
  if (!response.body) {
    throw new Error("chat response has no body");
  }
  const [clientBranch, authorityBranch] = response.body.tee();
  void drain(authorityBranch.getReader(), completed);
  const reader = clientBranch.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let failNextPull = false;
  let inputDone = false;

  async function readLine(): Promise<string | null> {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return line;
      }
      if (inputDone) {
        if (buffer.length === 0) {
          return null;
        }
        const line = buffer;
        buffer = "";
        return line;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        inputDone = true;
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (failNextPull) {
        await release.promise;
        controller.error(new TypeError("network error"));
        return;
      }

      const line = await readLine();
      if (line === null) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${line}\n`));

      if (line.length > 0) {
        const serialized = JSON.parse(line) as {
          readonly type?: unknown;
          readonly event?: { readonly type?: unknown };
        };
        const eventType = serialized.type ?? serialized.event?.type;
        if (eventType === EventType.TEXT_MESSAGE_CONTENT) {
          failNextPull = true;
          reached.resolve();
        }
      }
    },
    cancel() {
      void reader.cancel();
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createFaultingApplication(
  context: TestApplicationFactoryContext,
): Promise<TestApplication> {
  return Promise.resolve(
    createAcceptanceApplication(context, undefined, { retainResponseStreams: true }),
  ).then((application) => {
    let armed = false;
    let consumed = false;
    const reached = deferred();
    const release = deferred();
    const completed = deferred();

    return {
      ...application,
      async handle(request) {
        const body =
          request.method === "POST"
            ? await request
                .clone()
                .json()
                .catch(() => null)
            : null;
        const isCommand =
          body !== null &&
          typeof body === "object" &&
          "command" in (body as Record<string, unknown>);
        const response = await application.handle(request);
        if (!armed || consumed || !isCommand) {
          return response;
        }
        consumed = true;
        return failAfterFirstTextDelta(response, reached, release, completed);
      },
      scenario: {
        ...application.scenario,
        async armFault(point) {
          if (point !== LIVE_STREAM_AFTER_FIRST_TEXT) {
            throw new Error(`unknown fault point: ${point}`);
          }
          armed = true;
        },
        async waitForFault(point) {
          if (point === LIVE_STREAM_AFTER_FIRST_TEXT) {
            await reached.promise;
            release.resolve();
            return;
          }
          if (point === AUTHORITY_STREAM_COMPLETED) {
            await completed.promise;
            return;
          }
          throw new Error(`unknown fault point: ${point}`);
        },
      },
    };
  });
}

describe("authoritative stream reconciliation", () => {
  it("replays the complete committed response after the live stream fails mid-message", async () => {
    await withTestScenario(
      {
        binding: "http",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication: createFaultingApplication,
      },
      function* (s) {
        yield* s.faults.arm(LIVE_STREAM_AFTER_FIRST_TEXT);

        const conversation = s.conversation();
        const turn = yield* conversation.send("STREAM_RECONCILIATION_V1");
        const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        const response = yield* request.respond.textStream([
          "AUTHORITATIVE_FIRST_V1 ",
          "AUTHORITATIVE_SECOND_V1",
        ]);

        yield* response.releaseNext();
        yield* s.faults.reached(LIVE_STREAM_AFTER_FIRST_TEXT);
        yield* response.finish();
        yield* s.faults.reached(AUTHORITY_STREAM_COMPLETED);

        let settlementFailure: unknown;
        try {
          yield* turn.settled();
        } catch (error) {
          settlementFailure = error;
        }
        const recoveredProjection = JSON.stringify(conversation.snapshot().messages);

        // Authority completed despite the broken live response. A newly
        // opened client therefore reconstructs the complete committed text.
        const reopened = yield* conversation.reopen();
        expect(JSON.stringify(reopened.snapshot().messages)).toContain(
          "AUTHORITATIVE_FIRST_V1 AUTHORITATIVE_SECOND_V1",
        );

        // The original client must converge to the same authoritative state
        // rather than surfacing the network failure with a partial projection.
        expect(settlementFailure).toBeUndefined();
        expect(recoveredProjection).toContain("AUTHORITATIVE_FIRST_V1 AUTHORITATIVE_SECOND_V1");
        expect(s.model.requests()).toHaveLength(1);
      },
    );
  }, 30_000);
});
