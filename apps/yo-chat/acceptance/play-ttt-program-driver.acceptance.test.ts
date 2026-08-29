import type { ModelSampleResult, ModelSamplingService } from "@sweatpants/model-sampling";
// @vitest-environment node
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import type { ModelContext } from "@sweatpants/model-provider";
import {
  createProgramDriverJournalStore,
  createPinnedProgramCatalog,
  createProgramWorkflowHost,
  programDriverSchemaRegistry,
} from "@sweatpants/durable-chat-runtime/durable-handler";

import { playTttTool, type PlayTttResult } from "../src/tools/play-ttt/tool.ts";

const pin = {
  id: playTttTool.manifest.programId,
  version: playTttTool.manifest.version,
  digest: playTttTool.manifest.digest,
};

describe("journal-native play_ttt through the workflow host", () => {
  it("completes without ToolSession", async () => {
    let modelSamples = 0;
    let storedContext: ModelContext | undefined;
    let storedDigest = "";
    const programs = createDurableToolRegistry([playTttTool]);
    const effects = createDurableEffectRegistry([]);
    const modelSamplingService: ModelSamplingService = {
      *sample(request) {
        modelSamples += 1;
        const value: ModelSampleResult = {
          message: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "first legal cell" }],
            },
            source: null,
            usage: null,
            stopReason: "stop",
            responseId: null,
            errorMessage: null,
          },
          output: {
            type: "json",
            value: { cell: firstEmptyPosition(request.invocation.context.messages) },
          },
        };
        return { status: "ok" as const, value };
      },
    };
    const host = createProgramWorkflowHost({
      *modelContextSourceStager(context) {
        const snapshot = canonicalSnapshot(context);
        storedContext = context;
        storedDigest = snapshot.sha;
        return {
          type: "object",
          object: { objectId: "play-ttt-context" },
          digest: snapshot.sha,
        };
      },
      *modelContextSourceResolver(source) {
        if (
          source.type !== "object" ||
          source.object.objectId !== "play-ttt-context" ||
          source.digest !== storedDigest ||
          !storedContext
        ) {
          throw new Error("unexpected play_ttt model context source");
        }
        return storedContext;
      },
      journalStore: createProgramDriverJournalStore({
        keyring: createCapabilityKeyring("native-play-ttt", [
          { keyId: "active", secret: "native-play-ttt-key-material-32!!" },
        ]),
        schemaRegistry: programDriverSchemaRegistry(playTttTool.artifacts.catalog),
        executionStore: createMemoryExecutionStore(),
      }),
      programs,
      effects,
      modelSamplingService,
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
        route: { driverKind: "workflow" },
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
        operations.filter((operation) => operation.descriptor["kind"] === "sample"),
      ).toHaveLength(modelSamples);
      expect(
        operations.filter(
          (operation) =>
            operation.descriptor["kind"] === "record" &&
            operation.descriptor["key"] === "play-ttt-symbol-coin-flip",
        ),
      ).toHaveLength(1);
      expect(
        operations.filter((operation) => operation.descriptor["kind"] === "elicit"),
      ).toHaveLength(userResponses);
      expect(JSON.stringify(trace)).not.toContain("foreign.tool");
      expect(JSON.stringify(trace)).not.toContain("tool.execute");
    });

    expect(modelSamples).toBeGreaterThan(1);
  }, 15_000);
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
