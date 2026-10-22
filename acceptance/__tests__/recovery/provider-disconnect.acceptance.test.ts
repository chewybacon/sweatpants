import { describe, expect, it } from "vitest";
import { call, spawn } from "effection";
import { EventType } from "@ag-ui/core";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { useClient, waitForSnapshot } from "../../support/client.ts";

const options = { binding: "http" as const, createApplication };

describe("provider stream failure and recovery", () => {
  for (const failure of ["error", "partial", "disconnect", "oversized"] as const) {
    it(`retains accepted partial history and recovers after ${failure}`, async () => {
      await withTestScenario(options, function* (rig) {
        // Arrange: the provider is outside the real HTTP application.
        const client = yield* useClient(rig, { threadId: failure });
        const mark = rig.agui.mark();
        const partial = failure === "oversized" ? "H".repeat(32_768) : "Partial answer";

        // Act: fail before streaming or after one explicitly released delta.
        const sending = yield* spawn(() => call(() => client.sendMessage(`Failure ${failure}`)));
        const request = yield* rig.model.request();
        if (failure === "error") {
          yield* request.respond.error({
            code: "unavailable",
            message: "Planned outage",
            status: 503,
          });
        } else {
          const stream = yield* request.respond.textStream([partial, "UNRELEASED_TAIL"]);
          yield* stream.releaseNext();
          yield* waitForSnapshot(client, (state) =>
            JSON.stringify(state.messages).includes(partial),
          );
          if (failure === "disconnect") {
            yield* stream.disconnect();
          } else {
            yield* stream.fail({ code: "stream_failed", message: "Planned partial failure" });
          }
        }

        // Assert: exactly one error terminal, no success, and no unreleased tail.
        const failed = yield* waitForSnapshot(client, (state) => state.status === "error");
        yield* sending;
        const events = rig.agui.events(mark);
        expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1);
        expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
        if (failure !== "error") {
          const acceptedText = failed.messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          expect(acceptedText).toBe(partial);
        }
        expect(JSON.stringify(failed.messages)).not.toContain("UNRELEASED_TAIL");

        // Act: recover on the same client and inspect the actual model history.
        const recovery = yield* spawn(() => call(() => client.sendMessage("Recover")));
        const next = yield* rig.model.request();
        expect(JSON.stringify(next.body.input)).toContain("Recover");
        if (failure !== "error") {
          expect(JSON.stringify(next.body.input)).toContain(partial);
        }
        yield* next.respond.text("Recovered");
        yield* recovery;
        const ready = yield* waitForSnapshot(client, (state) => state.status === "ready");
        expect(ready.error).toBeNull();
      });
    });
  }

  it("settles empty output without manufacturing text and accepts a successor", async () => {
    await withTestScenario(options, function* (rig) {
      // Arrange.
      const client = yield* useClient(rig, { threadId: "empty" });
      const sending = yield* spawn(() => call(() => client.sendMessage("Empty answer")));

      // Act.
      const request = yield* rig.model.request();
      yield* request.respond.text("");
      yield* sending;
      const ready = yield* waitForSnapshot(client, (state) => state.status === "ready");

      // Assert: the assistant cannot invent text for an empty provider response.
      const assistants = ready.messages.filter((message) => message.role === "assistant");
      expect(
        assistants
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text")
          .every((part) => part.text === ""),
      ).toBe(true);
      const successor = yield* spawn(() => call(() => client.sendMessage("After empty")));
      const next = yield* rig.model.request();
      expect(JSON.stringify(next.body.input)).toContain("Empty answer");
      expect(JSON.stringify(next.body.input)).toContain("After empty");
      yield* next.respond.text("Continued");
      yield* successor;
      yield* waitForSnapshot(client, (state) => state.status === "ready");
    });
  });
});
