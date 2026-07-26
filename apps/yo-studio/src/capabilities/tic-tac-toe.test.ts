import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDurableToolRegistry,
  createLocalProgramDriver,
  type ProgramStep,
} from "@sweatpants/session-contract";
import {
  createWorkspaceService,
  installLocalWorkspaceFilesProvider,
  type WorkspaceFence,
} from "@sweatpants/workspace-runtime";

import { playTttTool } from "./tic-tac-toe.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("yo-studio play_ttt capability", () => {
  it("records the symbol flip, complete game, and cumulative win-loss record", async () => {
    const root = await mkdtemp(join(tmpdir(), "yo-studio-play-ttt-"));
    roots.push(root);
    const fence: WorkspaceFence = {
      taskId: "play-ttt-task",
      sandboxGeneration: "local-test-generation",
      activationEpoch: 1,
    };
    const service = createWorkspaceService({
      root,
      workspaceId: "play-ttt-workspace",
      scripts: {},
    });
    service.bind(fence);
    const driver = createLocalProgramDriver(createDurableToolRegistry([playTttTool]), {
      setup: function* () {
        yield* installLocalWorkspaceFilesProvider({
          resolve: function* () {
            return { operations: service.operations, fence };
          },
        });
      },
    });
    const labels: string[] = [];
    let elicitedMoves = 0;
    let terminalAcknowledgements = 0;

    const completed = await run(function* () {
      const attachment = yield* driver.attach({
        sessionId: "play-ttt-session",
        taskId: fence.taskId,
        program: {
          id: playTttTool.manifest.programId,
          version: playTttTool.manifest.version,
          digest: playTttTool.manifest.digest,
        },
        input: { gameId: "local-game" },
        route: { driverKind: "program" },
        executionEpoch: 1,
        affinity: { kind: "conversation", key: "play-ttt-session" },
      });
      let step: ProgramStep = yield* driver.step(attachment, {
        type: "start",
        input: { gameId: "local-game" },
      });
      let resolution = 0;
      try {
        while (step.type === "operation") {
          resolution += 1;
          const actionIndex = step.actionIndex;
          let outcome;
          if (step.descriptor.kind === "record") {
            labels.push(step.descriptor.label ?? "record");
            const authorized = yield* driver.step(attachment, {
              type: "authorize",
              actionIndex,
              pullId: `pull-${resolution}`,
              attemptId: `attempt-${resolution}`,
              resolutionCapability: `capability-${resolution}`,
              descriptor: step.descriptor,
            });
            if (authorized.type !== "operation" || !authorized.authorizedOutcome) {
              throw new Error("recording did not settle");
            }
            outcome = authorized.authorizedOutcome;
          } else if (step.descriptor.kind === "effect" && step.descriptor.name === "model.sample") {
            outcome = {
              status: "ok" as const,
              value: {
                text: '{"position":8}',
                calls: [],
                content: [],
                parsed: { position: 8 },
              },
            };
          } else if (step.descriptor.kind === "elicit") {
            const gameOver = containsGameOver(step.descriptor.context);
            const position = gameOver ? -1 : firstEmptyBoardPosition(step.descriptor.context);
            if (gameOver) {
              terminalAcknowledgements += 1;
            } else {
              elicitedMoves += 1;
            }
            outcome = {
              status: "ok" as const,
              value: { action: "accept", content: { position } },
            };
          } else {
            throw new Error(`unexpected durable boundary ${step.descriptor.kind}`);
          }
          step = yield* driver.step(attachment, {
            type: "resume",
            actionIndex,
            outcome,
            receipt: {
              sessionId: "play-ttt-session",
              taskId: fence.taskId,
              pullId: `pull-${resolution}`,
              resolutionOffset: String(resolution),
              outcomeDigest: resolution.toString(16).padStart(64, "0"),
              status: "accepted",
            },
            replayed: false,
          });
        }
        if (step.type !== "completed") {
          throw new Error(`game failed: ${JSON.stringify(step)}`);
        }
        return step;
      } finally {
        yield* driver.shutdown(attachment, "completed");
      }
    });

    const result = completed.value as {
      readonly gameId: string;
      readonly gamePath: string;
      readonly recordPath: string;
      readonly result: string;
    };
    expect(result).toMatchObject({
      gameId: "local-game",
      gamePath: "tic-tac-toe-game-local-game.json",
      recordPath: "tic-tac-toe-record.json",
    });
    expect(labels).toEqual([
      "yo-studio-play-ttt-symbol-coin-flip",
      "yo-studio-play-ttt-write-game",
      "yo-studio-play-ttt-write-record",
    ]);
    expect(elicitedMoves).toBeGreaterThan(1);
    expect(terminalAcknowledgements).toBe(1);
    const game = JSON.parse(
      await readFile(join(root, "tic-tac-toe-game-local-game.json"), "utf8"),
    ) as Record<string, unknown>;
    const record = JSON.parse(
      await readFile(join(root, "tic-tac-toe-record.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(game).toMatchObject({
      format: "yo-studio.tic-tac-toe-game.v2",
      gameId: "local-game",
      result: result.result,
    });
    expect(record).toMatchObject({
      format: "yo-studio.tic-tac-toe-record.v1",
      gamesPlayed: 1,
      games: [{ gameId: "local-game", result: result.result }],
    });
    expect(Number(record["modelWins"]) + Number(record["userWins"]) + Number(record["draws"])).toBe(
      1,
    );
  });
});

function containsGameOver(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsGameOver);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record["gameOver"] === true) {
      return true;
    }
    return Object.values(record).some(containsGameOver);
  }
  return false;
}

function firstEmptyBoardPosition(value: unknown): number {
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
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = firstEmptyBoardPosition(child);
      if (found >= 0) {
        return found;
      }
    }
  }
  return -1;
}
