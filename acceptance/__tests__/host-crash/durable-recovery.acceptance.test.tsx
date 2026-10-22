import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "effection";
import { expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import { createHostProcess } from "../../support/host-process.ts";
import { selectionPlugin } from "../../fixtures/selection-plugin.tsx";
import { useUI } from "../../support/ui.tsx";
import { waitForSnapshot } from "../../support/client.ts";

it("recovers accepted durable work after SIGKILL without executing its effect again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-host-crash-"));
  const effectLog = join(directory, "effect-executions.jsonl");
  let host: ReturnType<typeof createHostProcess>;
  try {
    await withTestScenario(
      {
        binding: "in-process",
        createApplication: async (context) => {
          // The test binding forwards every request to a separate real HTTP host.
          host = createHostProcess(context, join(directory, "authority.sqlite"), effectLog);
          await host.start();
          return host;
        },
      },
      function* (rig) {
        // Arrange: a fresh public client talks to the child host over HTTP.
        using first = yield* useUI(rig, { plugins: [selectionPlugin], threadId: "crash" });
        const send = yield* first.waitForEnabledButton("Book trip");

        // Act: accept an effect, record a value, finish sampling, and persist a choice.
        send.click();
        const request = yield* rig.model.request();
        yield* request.respond.toolCalls([
          { id: "crash-selection", name: "select_option", arguments: { topic: "crash" } },
        ]);
        const nested = yield* rig.model.request();
        yield* nested.respond.text("Accepted note before crash");
        yield* first.waitForEnabledButton("crash-alpha");
        yield* waitForSnapshot(first.client, (state) => state.authority?.state === "parked");
        const before = yield* call(() => readFile(effectLog, "utf8"));
        expect(before.trim().split("\n")).toHaveLength(1);
        const oldPid = JSON.parse(before.trim()).pid as number;

        // Act: abruptly kill the host, then reopen the same database in a new process.
        const exit = yield* call(() => host.kill());
        expect(exit).toEqual({ code: null, signal: "SIGKILL" });
        first[Symbol.dispose]();
        yield* call(() => first.client.close());
        const newPid = yield* call(() => host.start());
        expect(newPid).not.toBe(oldPid);
        using resumed = yield* useUI(rig, { plugins: [selectionPlugin], threadId: "crash" });
        yield* call(() => resumed.client.reconnect());

        // Assert: the persisted choice is restored without re-sampling or running the effect.
        const choice = yield* resumed.waitForEnabledButton("crash-beta");
        expect(rig.model.requests()).toHaveLength(2);
        expect(yield* call(() => readFile(effectLog, "utf8"))).toBe(before);

        // Act: finish the restored tool and its outer model response.
        choice.click();
        const final = yield* rig.model.request();
        expect(JSON.stringify(final.body.input)).toContain("crash-recorded");
        expect(JSON.stringify(final.body.input)).toContain("Accepted note before crash");
        expect(JSON.stringify(final.body.input)).toContain("crash-beta");
        const input = final.body.input;
        if (!Array.isArray(input)) {
          throw new Error("Expected provider input messages");
        }
        expect(
          input.filter(
            (item: Record<string, unknown>) =>
              item["type"] === "function_call_output" && item["call_id"] === "crash-selection",
          ),
        ).toHaveLength(1);
        yield* final.respond.text("Recovered after host crash");
        yield* resumed.waitForText("Recovered after host crash");
        yield* resumed.waitForEnabledButton("Book trip");

        // Assert: accepted history and one result survive across two OS processes.
        expect(yield* call(() => readFile(effectLog, "utf8"))).toBe(before);
        expect(resumed.client.getSnapshot().error).toBeNull();
        expect(rig.model.requests()).toHaveLength(3);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
