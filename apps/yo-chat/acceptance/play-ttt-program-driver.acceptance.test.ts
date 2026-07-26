// @vitest-environment node
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  MODEL_SAMPLE_EFFECT,
  createCapabilityKeyring,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createLocalProgramDriver,
  createProgramDriverRegistry,
  type Json,
} from "@sweatpants/session-contract";
import { createLocalWorkerDurableProgramDriver } from "@sweatpants/tool-runtime-local";
import {
  createInMemoryProgramDriverJournalStore,
  createLocalProgramHost,
  createPinnedProgramCatalog,
  programDriverSchemaRegistry,
} from "@sweatpants/framework/server";

import { playTttTool, type PlayTttResult } from "../src/tools/play-ttt/tool.ts";

const pin = {
  id: playTttTool.manifest.programId,
  version: playTttTool.manifest.version,
  digest: playTttTool.manifest.digest,
};

describe("journal-native play_ttt through ProgramRuntime", () => {
  it.each([
    ["program", "program"],
    ["worker", "worker"],
  ] as const)("completes through the %s driver without ToolSession", async (_label, driverKind) => {
    let modelSamples = 0;
    const programs = createDurableToolRegistry([playTttTool]);
    const effects = createDurableEffectRegistry([
      createDurableEffectRegistration(
        MODEL_SAMPLE_EFFECT,
        MODEL_SAMPLE_EFFECT.retrySafety,
        function* (request) {
          modelSamples += 1;
          return {
            status: "ok",
            value: {
              text: "first legal cell",
              calls: [],
              content: [],
              parsed: { cell: firstEmptyPosition(request.messages) },
            },
          };
        },
      ),
    ]);
    const driver =
      driverKind === "program"
        ? createLocalProgramDriver(programs)
        : createLocalWorkerDurableProgramDriver({
            workerUrl: new URL("./fixtures/durable-play-ttt-worker-bootstrap.mjs", import.meta.url),
            name: "play-ttt-conformance-worker",
            registry: programs,
          });
    const host = createLocalProgramHost({
      journalStore: createInMemoryProgramDriverJournalStore({
        keyring: createCapabilityKeyring("native-play-ttt", [
          { keyId: "active", secret: "native-play-ttt-key-material-32!!" },
        ]),
        schemaRegistry: programDriverSchemaRegistry(playTttTool.artifacts.catalog),
      }),
      programs,
      effects,
      drivers: createProgramDriverRegistry([[driverKind, driver]]),
    });
    const catalog = createPinnedProgramCatalog({
      play_ttt: { kind: "program", target: "play_ttt", program: pin },
    });

    await run(function* () {
      const opened = yield* host.open({
        program: pin,
        manifest: playTttTool.manifest,
        input: {},
        catalog,
        route: { driverKind },
      });
      let outcome = yield* opened.result;
      let userResponses = 0;
      for (let round = 0; outcome.state === "parked" && round < 12; round += 1) {
        const trace = yield* host.trace(opened.sessionId);
        const task = trace.tasks.find((candidate) => candidate.taskId === opened.taskId)!;
        const pending = [...task.operations]
          .reverse()
          .find((operation) => operation.outcome === undefined);
        if (!pending || pending.descriptor["kind"] !== "elicit") {
          throw new Error("Missing native play_ttt elicitation");
        }
        const context = pending.descriptor["context"] as Json;
        const position = containsGameOver(context) ? -1 : firstEmptyBoardPosition(context);
        outcome = yield* host.respond({
          sessionId: opened.sessionId,
          taskId: opened.taskId,
          pullId: pending.pullId,
          response: { action: "accept", content: { position } },
        });
        userResponses += 1;
      }

      expect(outcome.state).toBe("completed");
      if (outcome.state !== "completed") {
        throw new Error("game did not complete");
      }
      expect(outcome.value as PlayTttResult).toMatchObject({ success: true });
      const trace = yield* host.trace(opened.sessionId);
      const operations = trace.tasks[0]!.operations;
      expect(
        operations.filter((operation) => operation.descriptor["kind"] === "effect"),
      ).toHaveLength(modelSamples);
      expect(
        operations.filter(
          (operation) =>
            operation.descriptor["kind"] === "record" &&
            operation.descriptor["label"] === "play-ttt-symbol-coin-flip",
        ),
      ).toHaveLength(1);
      expect(
        operations.filter((operation) => operation.descriptor["kind"] === "elicit"),
      ).toHaveLength(userResponses);
      expect(JSON.stringify(trace)).not.toContain("foreign.tool");
      expect(JSON.stringify(trace)).not.toContain("tool.execute");
    });

    expect(modelSamples).toBeGreaterThan(1);
  });
});

function firstEmptyPosition(messages: Json[]): number {
  const match = /Empty positions:\s*([0-8](?:,\s*[0-8])*)/.exec(JSON.stringify(messages));
  return Number(match?.[1]?.split(",")[0] ?? 0);
}

function containsGameOver(value: Json): boolean {
  if (Array.isArray(value)) {
    return value.some(containsGameOver);
  }
  if (value && typeof value === "object") {
    if (value["gameOver"] === true) {
      return true;
    }
    return Object.values(value).some(containsGameOver);
  }
  return false;
}

function firstEmptyBoardPosition(value: Json): number {
  if (Array.isArray(value)) {
    if (
      value.length === 9 &&
      value.every((cell) => cell === null || cell === "X" || cell === "O")
    ) {
      return value.findIndex((cell) => cell === null);
    }
    for (const child of value) {
      const found = firstEmptyBoardPosition(child);
      if (found >= 0) {
        return found;
      }
    }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const found = firstEmptyBoardPosition(child);
      if (found >= 0) {
        return found;
      }
    }
  }
  return -1;
}
