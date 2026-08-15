import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./storage-spine-process.ts", import.meta.url));
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-spine-"));
  directories.push(directory);
  return directory;
}

function runProcess(
  args: string[],
  profile: "low" | "default",
  turnCount: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", script, ...args], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: {
        ...process.env,
        SPINE_PROFILE: profile,
        SPINE_TURN_COUNT: String(turnCount),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("database-backed durability spine producer/verifier", () => {
  it("reconstructs a real test-rig database from a fresh process", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "spine.sqlite");
    const expectedPath = join(directory, "expected.json");
    const produced = await runProcess(["producer", databasePath, expectedPath], "low", 10);
    expect(produced.code, produced.stderr || produced.stdout).toBe(0);
    const verified = await runProcess(["verifier", databasePath, expectedPath], "low", 10);
    expect(verified.code, verified.stderr || verified.stdout).toBe(0);
    expect(verified.stdout).toContain('"mode":"verifier"');
    const expected = JSON.parse(await readFile(expectedPath, "utf8")) as {
      verifierProfile: string;
      report: {
        hydrationReads: number;
        hydrationReadBytes: number;
        archivePageReads: number;
        publicHistoryIndexRows: number;
        publicHistoryIndexBytes: number;
        publicHistorySegmentReads: number;
        publicHistorySegmentReadBytes: number;
        peakPublicHistoryPageBytes: number;
        preparedContextReads: number;
        preparedContextReadBytes: number;
        preparedContextObjectBytes: number;
        checkpointWriteBytes: number;
        totalRetainedArchiveBytes: number;
      };
      privateEvidence: { journalSegments: number; replaySegments: number };
    };
    expect(expected.verifierProfile).toBe("low");
    expect(expected.report.hydrationReads).toBe(2);
    expect(expected.report.hydrationReadBytes).toBeGreaterThan(0);
    expect(expected.report.archivePageReads).toBeGreaterThan(0);
    expect(expected.report.publicHistoryIndexRows).toBeGreaterThan(0);
    expect(expected.report.publicHistoryIndexBytes).toBeGreaterThan(0);
    expect(expected.report.publicHistorySegmentReads).toBeGreaterThan(0);
    expect(expected.report.publicHistorySegmentReadBytes).toBeGreaterThan(0);
    expect(expected.report.peakPublicHistoryPageBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(expected.report.preparedContextReads).toBeGreaterThan(0);
    expect(expected.report.preparedContextReadBytes).toBeGreaterThan(0);
    expect(expected.report.preparedContextObjectBytes).toBeGreaterThan(0);
    expect(expected.report.checkpointWriteBytes).toBeGreaterThan(0);
    expect(expected.report.totalRetainedArchiveBytes).toBeGreaterThan(0);
    expect(expected.privateEvidence.journalSegments).toBeGreaterThanOrEqual(3);
    expect(expected.privateEvidence.replaySegments).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("crosses the default private and public segmentation thresholds", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "spine.sqlite");
    const expectedPath = join(directory, "expected.json");
    const produced = await runProcess(["producer", databasePath, expectedPath], "default", 20);
    expect(produced.code, produced.stderr || produced.stdout).toBe(0);
    const verified = await runProcess(["verifier", databasePath, expectedPath], "default", 20);
    expect(verified.code, verified.stderr || verified.stdout).toBe(0);
    const expected = JSON.parse(await readFile(expectedPath, "utf8")) as {
      verifierProfile: string;
      privateEvidence: { journalSegments: number; replaySegments: number };
      report: { tables: Record<string, { rows: number }> };
    };
    expect(expected.verifierProfile).toBe("default");
    expect(expected.privateEvidence.journalSegments).toBeGreaterThan(1);
    expect(expected.privateEvidence.replaySegments).toBeGreaterThan(1);
    expect(expected.report.tables["sp_conversation_public_segments"]?.rows).toBeGreaterThan(1);
  }, 180_000);
});
