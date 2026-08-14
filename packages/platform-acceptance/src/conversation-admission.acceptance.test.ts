import { call } from "effection";
import { describe, expect, it } from "vitest";
import { projectChatMessagesToAGUI } from "@sweatpants/chat-core";
import { withTestScenario } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type WireFrame = {
  readonly lsn: number;
  readonly event: {
    readonly type: string;
    readonly code?: string;
    readonly authority?: { readonly state?: string; readonly revision?: string };
  };
};

function parseFrames(body: string): readonly WireFrame[] {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireFrame);
}

describe("ordinary message admission", () => {
  it("preserves live assistant identity across the next authoritative snapshot", async () => {
    await withTestScenario(
      {
        binding: "in-process",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication: createAcceptanceApplication,
      },
      function* (s) {
        const conversation = s.conversation();
        const first = yield* conversation.send("IDENTITY_FIRST_USER_V1");
        const firstRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* firstRequest.respond.text("IDENTITY_FIRST_ASSISTANT_V1");
        yield* first.settled();

        const second = yield* conversation.send("IDENTITY_SECOND_USER_V1");
        const secondRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* secondRequest.respond.text("IDENTITY_SECOND_ASSISTANT_V1");
        yield* second.settled();

        const matching = conversation
          .snapshot()
          .messages.filter(
            (message) =>
              message.role === "assistant" &&
              JSON.stringify(message).includes("IDENTITY_FIRST_ASSISTANT_V1"),
          );
        expect(matching).toHaveLength(1);
      },
    );
  }, 30_000);

  it("returns typed current authority instead of an internal error while parked", async () => {
    await withTestScenario(
      {
        binding: "http",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication: createAcceptanceApplication,
      },
      function* (s) {
        const conversation = s.conversation({ initialToolChoice: "required" });
        const active = yield* conversation.send("PARK_FOR_ADMISSION_CONFLICT_V1");
        const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* outer.respond.toolCalls([
          {
            id: "admission-conflict-call",
            name: ACCEPTANCE_TOOL_NAME,
            arguments: { from: "NYC", destination: "LAX" },
          },
        ]);
        const pending = yield* active.elicit("pickFlight");
        const parked = yield* active.expectSnapshot(
          (snapshot) => snapshot.authority?.state === "parked",
        );
        const authority = parked.authority;
        if (authority?.state !== "parked") {
          throw new Error("Expected parked authority before conflict probe");
        }

        // RAW-TRANSPORT: scenario.send intentionally prevents an invalid second
        // ordinary command. This probes the public admission rejection itself.
        const runId = crypto.randomUUID();
        const response = yield* call(() =>
          s.transport.fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
            body: JSON.stringify({
              command: {
                type: "send-message",
                commandId: runId,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                basisRevision: authority.revision,
                messageId: "admission-conflict-user",
              },
              clientId: "admission-conflict-client",
              conversationId: conversation.conversationId,
              input: {
                threadId: conversation.conversationId,
                runId,
                state: {},
                messages: [
                  ...projectChatMessagesToAGUI(parked.messages),
                  {
                    id: "admission-conflict-user",
                    role: "user",
                    content: "MUST_NOT_BE_ADMITTED_V1",
                  },
                ],
                tools: [],
                context: [],
                forwardedProps: {},
              },
            }),
          }),
        );
        const frames = parseFrames(yield* call(() => response.text()));
        expect(frames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: expect.objectContaining({
                type: "sweatpants.conversation-authority.v1",
                authority: expect.objectContaining({ state: "parked" }),
              }),
            }),
            expect.objectContaining({
              event: expect.objectContaining({
                type: "RUN_ERROR",
                code: "conversation_not_idle",
              }),
            }),
          ]),
        );
        expect(s.model.requests()).toHaveLength(1);

        yield* pending.cancel();
        const final = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* final.respond.text("ADMISSION_CONFLICT_CLEANUP_V1");
        yield* active.settled();
      },
    );
  }, 30_000);
});
