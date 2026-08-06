import { call, sleep, spawn } from "effection";
import { describe, expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "./lib/acceptance-app.ts";

describe("graceful Host shutdown", () => {
  it("stops intake, drains an eager model stream, and then closes", async () => {
    let application: ReturnType<typeof createAcceptanceApplication> | undefined;

    await withTestScenario(
      {
        binding: "in-process",
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication(context) {
          application = createAcceptanceApplication(context, undefined, {
            retainResponseStreams: true,
          });
          return application;
        },
      },
      function* (s) {
        const turn = yield* s.conversation().send({ text: "GRACEFUL_SHUTDOWN_V1" });
        const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        const response = yield* request.respond.textStream([
          "SHUTDOWN_FIRST_V1",
          "SHUTDOWN_SECOND_V1",
        ]);
        yield* response.releaseNext();

        let closeSettled = false;
        const closing = yield* spawn(function* () {
          if (!application) {
            throw new Error("application was not captured");
          }
          yield* call(() => application!.close());
          closeSettled = true;
        });
        yield* sleep(0);
        expect(closeSettled).toBe(false);

        // The provider completion is out-of-band from the request/Host close.
        // Graceful close waits for the writer rather than cancelling paid-for
        // tokens after the first released delta.
        yield* response.finish();
        yield* closing;
        expect(closeSettled).toBe(true);

        // The Turn reached terminal before shutdown completed.
        expect((yield* turn.settled()).text).toBe("SHUTDOWN_FIRST_V1SHUTDOWN_SECOND_V1");
        let closedError: unknown;
        try {
          yield* call(() => application!.handle(new Request("http://localhost/chat")));
        } catch (error) {
          closedError = error;
        }
        expect(closedError).toMatchObject({ name: "ChatApplicationClosedError" });
      },
    );
  }, 30_000);
});
