import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, run } from "effection";
import { expect, it } from "vitest";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { createSimulatorModel, startModelSimulator } from "@sweatpants/test-rig";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { createEffectionProviderChat } from "../../../experiments/standard-durability/provider-chat.ts";

it.each(["success", "provider-error", "cancel"] as const)(
  "uses the real Pi provider through the typed API: %s",
  async (mode) => {
    const simulator = await startModelSimulator(undefined, { unmatchedRequests: "buffer" });
    const directory = await mkdtemp(join(tmpdir(), "typed-provider-"));
    const database = join(directory, "chat.sqlite");
    const input = {
      messageId: mode,
      text: "Hello",
      modelIdentity: "simulator",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    };
    const identity = {
      executionId: mode,
      program: { id: "typed-provider", version: "1", digest: "typed-provider-v1" },
      input,
    };
    let journal = new SqliteJournal(database, identity);
    const chat = createEffectionProviderChat(createPiAiModelProvider().driver);
    const capabilities = {
      model: {
        model: createSimulatorModel("typed-provider", simulator.baseUrl),
        streamOptions: { apiKey: "sk-sweatpants-test-only", temperature: 0.25 },
      },
      tools: [],
      effects: {},
    };
    const published: string[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blocked = true;
    const execution = run(function* () {
      yield* chat.Output.around({
        *publish([event], next) {
          if (event.type === "text-delta" && blocked) {
            entered.resolve();
            yield* call(() => release.promise);
            blocked = false;
          }
          yield* next(event);
        },
      });
      return yield* chat.activate(capabilities, input, journal, {
        publish(event) {
          if (event.type === "text-delta") {
            published.push(event.delta);
          }
        },
      });
    });
    const result = Promise.resolve(execution).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const request = await simulator.model.nextRequest();
      expect(request.body.model).toBe("typed-provider");
      expect(request.body.temperature).toBe(0.25);
      if (mode === "provider-error") {
        await request.respond.error({
          code: "unavailable",
          message: "Planned outage",
          status: 400,
        });
        const failed = await result;
        expect(failed.ok).toBe(false);
        const accepted = journal.readAccepted(0)?.outcome;
        expect(accepted).toMatchObject({
          ok: true,
          value: { ok: false, error: { code: "model-error" } },
        });
        expect(JSON.stringify(accepted)).toContain("Planned outage");
      } else if (mode === "cancel") {
        const aborted = request.respond.awaitAbort();
        await execution.halt();
        await aborted;
        expect(journal.read().entries).toHaveLength(0);
        expect(published).toEqual([]);
      } else {
        const stream = await request.respond.text({
          chunks: ["Hello", " world"],
          release: "manual",
        });
        await stream.releaseNext();
        await entered.promise;
        expect(published).toEqual([]);
        expect(journal.read().entries).toHaveLength(0);
        release.resolve();
        await stream.releaseNext();
        await stream.finish();
        const completed = await result;
        expect(completed.ok).toBe(true);
        expect(published.join("")).toBe("Hello world");
        expect(journal.read().status).toBe("completed");
        expect(journal.readAccepted(0)?.outcome).toMatchObject({
          ok: true,
          value: { ok: true, value: { errorMessage: null } },
        });
      }
      expect(JSON.stringify(journal.read().entries)).not.toContain("sk-sweatpants-test-only");
      if (mode !== "cancel") {
        journal.close();
        journal = new SqliteJournal(database, identity);
        const fresh = createEffectionProviderChat(createPiAiModelProvider().driver);
        const replay = run(() => fresh.activate(capabilities, input, journal));
        if (mode === "provider-error") {
          await expect(Promise.resolve(replay)).rejects.toThrow("Planned outage");
        } else {
          expect((await replay).state).toBe("completed");
        }
        expect(simulator.model.requests()).toHaveLength(1);
      }
      simulator.verify();
    } finally {
      release.resolve();
      await execution.halt();
      journal.close();
      await simulator.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
