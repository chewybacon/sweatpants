import { validateConversationSegment } from "../../../packages/chat-core/src/client/conversation-stream-validator.ts";
import { watch, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { call, spawn } from "effection";
import { expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import { createHostProcess } from "../../support/host-process.ts";
import { useUI } from "../../support/ui.tsx";
import { waitForSnapshot } from "../../support/client.ts";
import { pickCardPlugin } from "../../../apps/yo-chat/src/tools/pick-card/plugin.ts";

it("actual local cards survive SIGKILL and preserve the selected fact for follow-up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-card-recovery-"));
  const database = join(directory, "chat.sqlite");
  let host: ReturnType<typeof createHostProcess>;
  try {
    await withTestScenario(
      {
        binding: "in-process",
        createApplication: async (context) => {
          host = createHostProcess(
            context,
            database,
            "unused",
            "__tests__/host-crash/fixtures/yo-chat-local.ts",
          );
          await host.start();
          return host;
        },
      },
      function* (rig) {
        using first = yield* useUI(rig, {
          api: "/api/chat",
          threadId: "cards",
          plugins: [pickCardPlugin],
        });
        (yield* first.waitForEnabledButton("Book trip")).click();
        const model = yield* rig.model.request();
        yield* model.respond.toolCalls([
          { id: "draw", name: "pick_card", arguments: { count: 3 } },
        ]);
        yield* waitForSnapshot(first.client, (state) => state.authority?.state === "parked");
        const offered = yield* first.waitForElement<HTMLButtonElement>(
          "offered card",
          () =>
            first
              .queryAllByRole<HTMLButtonElement>("button")
              .find((button) => /[♥♦♣♠]/.test(button.textContent ?? "")) ?? null,
        );
        const card = offered.textContent!.trim();
        const db = new DatabaseSync(database);
        const before = db.prepare("SELECT * FROM exchanges ORDER BY sequence").all();
        db.close();
        expect(before).toHaveLength(2);
        first[Symbol.dispose]();
        yield* call(() => first.client.close());
        expect(yield* call(() => host.kill())).toEqual({ code: null, signal: "SIGKILL" });
        yield* call(() => host.start());
        using resumed = yield* useUI(rig, {
          api: "/api/chat",
          threadId: "cards",
          plugins: [pickCardPlugin],
        });
        (yield* resumed.waitForEnabledButton(card)).click();
        const final = yield* rig.model.request();
        expect(JSON.stringify(final.body.input)).toContain(card);
        yield* final.respond.text(`You picked ${card}.`);
        yield* resumed.waitForText(`You picked ${card}.`);
        yield* waitForSnapshot(resumed.client, (state) => state.status === "ready");
        const restored = new DatabaseSync(database);
        expect(
          restored.prepare("SELECT * FROM exchanges WHERE sequence < 2 ORDER BY sequence").all(),
        ).toEqual(before);
        expect(
          restored.prepare("SELECT COUNT(*) AS n FROM attempts WHERE sequence=1").get()!.n,
        ).toBe(1);
        restored.close();
        const follow = yield* spawn(() =>
          call(() => resumed.client.sendMessage("What card did I pick?")),
        );
        const next = yield* rig.model.request();
        expect(JSON.stringify(next.body.input)).toContain(card);
        yield* next.respond.text(`It was ${card}.`);
        yield* follow;
        expect(rig.model.requests()).toHaveLength(3);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("finishes an admitted Stop after SIGKILL without resuming the cancelled provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-stop-recovery-"));
  const database = join(directory, "chat.sqlite");
  const marker = join(directory, "native.stop-ready");
  let host: ReturnType<typeof createHostProcess>;
  try {
    await withTestScenario(
      {
        binding: "in-process",
        createApplication: async (context) => {
          host = createHostProcess(
            context,
            database,
            marker,
            "__tests__/host-crash/fixtures/yo-chat-local.ts",
          );
          await host.start();
          return host;
        },
      },
      function* (rig) {
        using first = yield* useUI(rig, { api: "/api/chat", threadId: "stop", plugins: [] });
        yield* first.waitForEnabledButton("Book trip");
        const sending = yield* spawn(() =>
          call(() => first.client.sendMessage("Wait for Stop").catch(() => {})),
        );
        const request = yield* rig.model.request();
        const aborted = yield* spawn(() => request.respond.awaitAbort());
        yield* waitForSnapshot(first.client, (state) => state.authority?.state === "running");
        const cleanupEntered = new Promise<void>((resolve, reject) => {
          const watcher = watch(directory, () => {
            if (existsSync(marker)) {
              clearTimeout(timer);
              watcher.close();
              resolve();
            }
          });
          const timer = setTimeout(() => {
            watcher.close();
            reject(new Error("Native cleanup did not enter"));
          }, 5000);
        });
        const stopping = yield* spawn(() => call(() => first.client.stop().catch(() => {})));
        yield* call(() => cleanupEntered);
        const db = new DatabaseSync(database);
        expect(db.prepare("SELECT status FROM executions").get()!.status).toBe("interrupting");
        expect(db.prepare("SELECT COUNT(*) AS n FROM chat_commands").get()!.n).toBe(2);
        const receipt = String(
          db.prepare("SELECT envelope FROM chat_commands ORDER BY rowid DESC LIMIT 1").get()!
            .envelope,
        );
        db.close();
        expect(yield* call(() => host.kill())).toEqual({ code: null, signal: "SIGKILL" });
        yield* aborted;
        yield* stopping;
        yield* sending;
        first[Symbol.dispose]();
        yield* call(() => first.client.close());
        yield* call(() => host.start());
        const retryStop = () =>
          host.handle(
            new Request("http://local/api/chat", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: receipt,
            }),
          );
        // The identical command must recover admission itself, before any client hydration.
        const retry = yield* call(retryStop);
        expect(retry.status).toBe(200);
        const retryBody = yield* call(() => retry.text());
        const frames = retryBody
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        validateConversationSegment(frames);
        expect(frames.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "PROGRAM_CANCELLED" });
        using resumed = yield* useUI(rig, { api: "/api/chat", threadId: "stop", plugins: [] });
        yield* waitForSnapshot(resumed.client, (state) => state.authority?.state === "idle");
        expect(rig.model.requests()).toHaveLength(1);
        const settled = new DatabaseSync(database);
        expect(settled.prepare("SELECT status FROM executions").get()!.status).toBe("cancelled");
        settled.close();
        const follow = yield* spawn(() => call(() => resumed.client.sendMessage("New turn")));
        const next = yield* rig.model.request();
        const later = yield* waitForSnapshot(
          resumed.client,
          (state) => state.authority?.state === "running",
        );
        const laterAuthority = later.authority!;
        const oldRetry = yield* call(retryStop);
        const oldBody = yield* call(() => oldRetry.text());
        const oldFrames = oldBody
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        validateConversationSegment(oldFrames);
        expect(oldFrames[0].authority).toEqual(laterAuthority);
        expect(oldFrames.at(-1)).toMatchObject({ code: "INTERRUPT_ALREADY_SETTLED" });
        expect(
          oldFrames.some((frame: { code?: string }) => frame.code === "PROGRAM_CANCELLED"),
        ).toBe(false);
        yield* next.respond.text("Recovered cancellation.");
        yield* follow;
        expect(resumed.client.getSnapshot().error).toBeNull();
        expect(rig.model.requests()).toHaveLength(2);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("replaces unaccepted streamed content after SIGKILL and excludes it from follow-up history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-stream-recovery-"));
  const database = join(directory, "chat.sqlite");
  let host: ReturnType<typeof createHostProcess>;
  try {
    await withTestScenario(
      {
        binding: "in-process",
        createApplication: async (context) => {
          host = createHostProcess(
            context,
            database,
            "unused",
            "__tests__/host-crash/fixtures/yo-chat-local.ts",
          );
          await host.start();
          return host;
        },
      },
      function* (rig) {
        using first = yield* useUI(rig, { api: "/api/chat", threadId: "stream", plugins: [] });
        yield* first.waitForEnabledButton("Book trip");
        const sending = yield* spawn(() =>
          call(() => first.client.sendMessage("Recover this response").catch(() => {})),
        );
        const request = yield* rig.model.request();
        const stream = yield* request.respond.textStream([
          "abandoned provisional text",
          "never accepted",
        ]);
        yield* stream.releaseNext();
        yield* waitForSnapshot(first.client, (state) =>
          JSON.stringify(state.messages).includes("abandoned provisional text"),
        );
        expect(yield* call(() => host.kill())).toEqual({ code: null, signal: "SIGKILL" });
        // Retire the simulator response after the real process has exited.
        yield* stream.disconnect();
        yield* sending;
        first[Symbol.dispose]();
        yield* call(() => first.client.close());
        yield* call(() => host.start());
        using resumed = yield* useUI(rig, { api: "/api/chat", threadId: "stream", plugins: [] });
        const replacement = yield* rig.model.request();
        yield* replacement.respond.text("Accepted replacement.");
        yield* call(() => resumed.client.initialized);
        yield* waitForSnapshot(resumed.client, (state) => state.status === "ready");
        expect(JSON.stringify(resumed.client.getSnapshot().messages)).toContain(
          "Accepted replacement.",
        );
        expect(JSON.stringify(resumed.client.getSnapshot().messages)).not.toContain(
          "abandoned provisional text",
        );
        const follow = yield* spawn(() => call(() => resumed.client.sendMessage("Continue")));
        const next = yield* rig.model.request();
        expect(JSON.stringify(next.body.input)).toContain("Accepted replacement.");
        expect(JSON.stringify(next.body.input)).not.toContain("abandoned provisional text");
        yield* next.respond.text("Continued.");
        yield* follow;
        expect(rig.model.requests()).toHaveLength(3);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
