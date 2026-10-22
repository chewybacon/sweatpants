// @vitest-environment node
import { resolve } from "node:path";
import { call, spawn } from "effection";
import { describe, expect, it } from "vitest";
import { makePlugin } from "@sweatpants/react-chat";
import { local } from "@sweatpants/tool-runtime-local";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../../fixtures/application.ts";
import { workerContext } from "../../../fixtures/worker-context.ts";
import { useClient, waitForSnapshot } from "../../../support/client.ts";

describe("authored worker context", () => {
  for (const action of ["accept", "decline", "cancel"] as const) {
    it(`tracks the actual worker exchanges for ${action}`, async () => {
      await withTestScenario(
        {
          binding: "http",
          createApplication: (context) =>
            createApplication(context, {
              tools: [workerContext],
              execution: local({
                worker: resolve("__tests__/tool-runtimes/local-worker/fixtures/tool-worker.mjs"),
              }),
            }),
        },
        function* (rig) {
          // Arrange: author a headless plugin against the same typed tool contract.
          const plugin = makePlugin(workerContext)
            .onElicit({
              first: function* () {
                return action === "accept" ? { action, content: { value: "first" } } : { action };
              },
              second: function* () {
                return { action: "accept", content: { value: "second" } };
              },
            })
            .build();
          const client = yield* useClient(rig, {
            threadId: `context-${action}`,
            plugins: [plugin],
          });

          // Act: run the tool in a real worker and control its named sample.
          const sending = yield* spawn(() =>
            call(() => client.sendMessage("Observe worker context")),
          );
          const outer = yield* rig.model.request();
          expect(outer.pullId).not.toBe("");
          expect(JSON.stringify(outer.body.tools)).toContain("worker_context");
          yield* outer.respond.toolCalls([
            { id: "context", name: "worker_context", arguments: {} },
          ]);
          if (action === "accept") {
            const nested = yield* rig.model.request();
            expect(nested.pullId).not.toBe(outer.pullId);
            expect(nested.pullId).not.toBe("");
            expect(JSON.stringify(nested.body.input)).toContain("PRIVATE_CONTEXT_NOTE");
            yield* nested.respond.text("A named note");
          }
          const final = yield* rig.model.request();
          const input = final.body.input;
          if (!Array.isArray(input)) {
            throw new Error("Expected provider input");
          }
          const result = input.find(
            (item: Record<string, unknown>) =>
              item["type"] === "function_call_output" && item["call_id"] === "context",
          );
          expect(result).toBeDefined();
          const output = JSON.parse(String(result?.["output"]));

          // Assert: the real tool sees two messages per accepted elicit/sample exchange.
          if (action === "accept") {
            expect(output).toMatchObject({
              selected: true,
              first: "first",
              second: "second",
              note: "A named note",
              before: 4,
              after: 6,
              isMainThread: false,
              threadId: expect.any(Number),
            });
          } else {
            expect(output).toEqual({ selected: false, reason: action });
          }
          yield* final.respond.text("Context complete");
          yield* sending;
          const ready = yield* waitForSnapshot(client, (state) => state.status === "ready");
          expect(ready.error).toBeNull();
          expect(rig.model.requests()).toHaveLength(action === "accept" ? 3 : 2);
        },
      );
    });
  }
});
