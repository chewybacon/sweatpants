import { defineDurableEffect } from "@sweatpants/session-contract";

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { call, run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { canonicalJson, createDurableEffectRegistry } from "@sweatpants/session-contract";
import {
  DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES,
  DURABLE_DRIVER_FIXTURE_TOOLS,
} from "@sweatpants/session-contract/testing";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  PeerDelegatedEffectCoordinator,
  buildPeerOffer,
  createHttpDelegatedEffectsClient,
  createPeerRequirementManifest,
  createSecureForeignA2AHttpTransport,
  definePeerEffectContract,
  negotiatePeerGrantSet,
  type PeerInvocationPin,
  type PeerRetentionV1,
} from "../index.ts";

const children = new Set<ChildProcess>();
const repoRoot = resolve(import.meta.dirname, "../../../..");
const calleeFixture = resolve(import.meta.dirname, "fixtures/peer-callee-process.ts");
const callerFixture = resolve(import.meta.dirname, "fixtures/peer-caller-resolver-process.ts");
const effectFixture = resolve(import.meta.dirname, "fixtures/peer-effect-executor-process.ts");
afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children.clear();
});

const baseEffect = DURABLE_DRIVER_FIXTURE_TOOLS[0]!.manifest.effects["echo"]!;
const consultation = defineDurableEffect<string, string>({
  name: "app.consult_caller",
  version: "1.0.0",
  inputSchema: baseEffect.inputSchema,
  outputSchema: baseEffect.outputSchema,
  retrySafety: baseEffect.retrySafety,
});
const contract = definePeerEffectContract(consultation);
const inputSchema = DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES.find(
  (entry) => entry.descriptor.digest === consultation.inputSchema.digest,
)!.schema;
const outputSchema = DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES.find(
  (entry) => entry.descriptor.digest === consultation.outputSchema.digest,
)!.schema;
const registry = createDurableEffectRegistry([
  createDurableEffectRegistration(
    consultation,
    { mode: "idempotent", mechanism: "pull_id_key" },
    function* (input) {
      return { status: "ok", value: input };
    },
    { input: inputSchema, output: outputSchema },
  ),
]);
const manifest = createPeerRequirementManifest({
  skillId: "peer-certification",
  amendmentRequests: true,
  releaseDigest: "a".repeat(64),
  requirements: [
    {
      contract,
      availability: "caller_required",
      required: true,
      allowedRoutes: ["caller"],
    },
  ],
});
const offer = buildPeerOffer({
  manifest,
  routes: {
    "app.consult_caller": {
      contractDigest: contract.contractDigest,
      route: "caller",
      budget: { calls: 1 },
      delegation: { mode: "none" },
    },
  },
  effectRegistry: registry,
  amendmentRequests: true,
});
const grants = negotiatePeerGrantSet({
  manifest,
  offer,
  callerIdentity: "caller-process",
  calleeIdentity: "callee-process",
  invocationId: "peer-invocation-process",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});
const retention: PeerRetentionV1 = {
  taskSeconds: 3600,
  invocationBindingSeconds: 3600,
  effectEventSeconds: 3600,
  grantSeconds: 3600,
  effectResponseSeconds: 3600,
  cancellationEvidenceSeconds: 3600,
  terminalEvidenceSeconds: 3600,
};

describe("three-process Sweatpants peer certification", () => {
  it("keeps caller credentials local and survives a lost callee response acknowledgment without duplicate effect execution", async () => {
    const directory = mkdtempSync(`${tmpdir()}/peer-cert-`);
    try {
      const port = await reservePort();
      const callee = start(calleeFixture, {
        PEER_CALLEE_PORT: String(port),
        PEER_GRANT_SET: canonicalJson(grants),
        PEER_RETENTION: canonicalJson(retention),
      });
      await ready(callee);
      const origin = `http://127.0.0.1:${port}`;
      const pin = peerPin(origin);
      const client = createHttpDelegatedEffectsClient(
        createSecureForeignA2AHttpTransport({
          cardOrigin: origin,
          urlPolicy: { allowLocalhostTests: true },
        }),
      );
      const coordinator = new PeerDelegatedEffectCoordinator({
        pin,
        taskId: "peer-task-process",
        client,
      });
      let state = await run(() => coordinator.observe(coordinator.initialState()));
      const countPath = resolve(directory, "effect-count");
      const snapshotPath = resolve(directory, "caller-authority.json");
      const crashMarker = resolve(directory, "caller-crashed");
      state = await run(() =>
        coordinator.prepareNextResponse(state, function* (input) {
          const environment = {
            PEER_GRANT: canonicalJson(grants.grants[0]!),
            PEER_RESOLVER_INPUT: canonicalJson(input),
            PEER_CALLER_AUTHORITY_SNAPSHOT: snapshotPath,
            PEER_EFFECT_COUNT_PATH: countPath,
            PEER_EFFECT_FIXTURE: effectFixture,
            PEER_CALLER_CRASH_MARKER: crashMarker,
          };
          const crashedCaller = start(callerFixture, environment);
          const crashed = yield* call(() => exited(crashedCaller));
          if (crashed.signal !== "SIGKILL") {
            throw new Error(`caller did not crash at resolver boundary: ${crashed.stderr}`);
          }
          const recoveredCaller = start(callerFixture, environment);
          const recovered = yield* call(() => exited(recoveredCaller));
          const line = recovered.stdout
            .split("\n")
            .find((candidate) => candidate.startsWith("OUTCOME "));
          if (!line) {
            throw new Error(`caller recovery emitted no outcome: ${recovered.stderr}`);
          }
          return JSON.parse(line.slice("OUTCOME ".length));
        }),
      );
      await expect(run(() => coordinator.deliverOutbox(state))).rejects.toBeDefined();
      state = await run(() => coordinator.deliverOutbox(state));
      expect(state.executionCursor).toBe(1);
      expect(readFileSync(countPath, "utf8")).toBe("1");
      const stats = (await fetch(`${origin}/stats`).then((response) => response.json())) as {
        resolveCalls: number;
        status: { status: string };
        calleeJournalRecords: number;
        calleeTaskClosures: number;
      };
      expect(stats).toMatchObject({ resolveCalls: 1, status: { status: "resolved" } });
      expect(stats.calleeJournalRecords).toBeGreaterThan(0);
      expect(stats.calleeTaskClosures).toBe(1);
      expect(callee.spawnargs.join(" ")).not.toContain("CALLER_SECRET_TOKEN");
      callee.kill("SIGTERM");
      await exited(callee);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

function peerPin(origin: string): PeerInvocationPin {
  return {
    foreign: {
      cardDigest: "b".repeat(64),
      agentName: "callee-process",
      skillId: "peer-certification",
      interface: { url: `${origin}/a2a`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
      extensionUris: [DURABLE_INVOCATION_EXTENSION_URI],
      guarantee: {
        level: "reconciled",
        source: "durable_invocation_extension",
        negotiatedAt: new Date().toISOString(),
        invocationExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        messageIdempotencyExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        extension: {
          protocolVersion: 1,
          resolveEndpoint: `${origin}/invocations:resolve`,
          abortEndpoint: `${origin}/invocations:abort`,
          messageIdempotency: true,
          retention: {
            invocationBindingSeconds: 3600,
            abortTombstoneSeconds: 3600,
            messageIdempotencySeconds: 3600,
            taskSeconds: 3600,
            terminalResultSeconds: 3600,
            clockSkewSeconds: 5,
          },
        },
      },
      ambiguityPolicy: "surface",
      invocationId: "peer-invocation-process",
      initialMessageId: "peer-message-process",
      requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      principalId: "caller-process",
    },
    calleeIdentity: "callee-process",
    requirementManifest: manifest,
    grantSet: grants,
    profile: {
      protocolVersion: 1,
      delegatedEffectsVersion: 1,
      requirementManifestEndpoint: `${origin}/requirements`,
      delegatedEffectsEndpoint: `${origin}/peer`,
      retention,
    },
    retentionExpiresAt: Object.fromEntries(
      Object.keys(retention).map((key) => [key, new Date(Date.now() + 3600_000).toISOString()]),
    ) as PeerInvocationPin["retentionExpiresAt"],
  };
}
function start(script: string, environment: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", script], {
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function ready(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`callee not ready: ${output}`)), 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("READY")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
}
function exited(
  child: ChildProcess,
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("exit", (code, signal) => resolveExit({ stdout, stderr, code, signal }));
  });
}
async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("port unavailable");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}
