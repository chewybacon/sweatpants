import { describe, expect, it } from "vitest";
import {
  DURABLE_INVOCATION_FORMAT,
  FiniteHttpRestoreProtocol,
  InMemoryDurableIdempotencyStore,
  InMemoryImmutableObjectStore,
  assertClientCapabilities,
  assertSandboxFence,
  chooseSandboxRecovery,
  createDurableInvocationIdentity,
  createMcpInventory,
  createWorkspaceVersion,
  parseDurableInvocationMeta,
  replayChainDigest,
  replayPageDigest,
  restoreWorkspaceVersion,
  type RestoreCreate,
  type SandboxCapabilities,
  type SandboxInspection,
} from "../index.ts";
import { sha256 } from "../canonical.ts";

const digest = (value: string) => sha256(value);
const capabilities: SandboxCapabilities = {
  requestResponse: true,
  websocket: false,
  warmAttachments: false,
  memorySuspend: true,
  localDisk: true,
  workspacePersistence: "sandbox_lease",
  checkpointRestore: true,
  shell: true,
  processExecution: true,
  ports: false,
  networkPolicy: true,
};

function inventory() {
  return createMcpInventory({
    collectionDigest: digest("collection"),
    evaluatorAbi: "program-driver.v1",
    tools: {
      pick_card: {
        programId: "yo.pick-card",
        version: "1",
        programDigest: digest("program"),
        inputSchemaDigest: digest("input"),
        outputSchemaDigest: digest("output"),
        requiredClientCapabilities: ["elicitation"],
      },
    },
  });
}

function restoreCreate(): RestoreCreate {
  return {
    protocolVersion: 1,
    taskId: "task",
    exactProgram: { id: "program", version: "1", digest: digest("program") },
    collection: {
      provider: "memory",
      namespace: "test",
      key: "collection",
      digest: digest("collection"),
      bytes: 1,
    },
    sandboxGeneration: "2",
    activationEpoch: 3,
    journalHeadDigest: digest("head"),
    replayChainSeed: digest("seed"),
  };
}

describe("portable durable MCP boundary contracts", () => {
  it("validates sweatpants.chat metadata and scopes task-opening idempotency", async () => {
    const generation = inventory();
    const metadata = parseDurableInvocationMeta({
      format: DURABLE_INVOCATION_FORMAT,
      idempotencyKey: "retry-1",
      inventoryGeneration: generation.digest,
    });
    expect(metadata.format).toBe("sweatpants.chat/durable-invocations.v1");
    const identity = createDurableInvocationIdentity({
      serverId: "server",
      callerHash: digest("caller"),
      toolName: "pick_card",
      inventory: generation,
      metadata,
      arguments: { count: 3 },
    });
    const store = new InMemoryDurableIdempotencyStore<string>();
    await expect(store.createOrReturn(identity, "task-1")).resolves.toEqual({
      status: "created",
      value: "task-1",
    });
    await expect(store.createOrReturn(identity, "task-2")).resolves.toEqual({
      status: "existing",
      value: "task-1",
    });
    await expect(
      store.createOrReturn({ ...identity, argumentDigest: digest("different") }, "task-3"),
    ).resolves.toEqual({ status: "conflict" });
    expect(() => parseDurableInvocationMeta({ ...metadata, unknown: true })).toThrow(
      /Unknown or missing metadata field/,
    );
    expect(() =>
      parseDurableInvocationMeta({ ...metadata, idempotencyKey: "x".repeat(257) }),
    ).toThrow(/Idempotency key must be/);
  });

  it("rejects inventory mismatch and missing negotiated client capability", () => {
    const generation = inventory();
    const metadata = parseDurableInvocationMeta({
      format: DURABLE_INVOCATION_FORMAT,
      idempotencyKey: "retry-1",
      inventoryGeneration: digest("wrong-generation"),
    });
    expect(() =>
      createDurableInvocationIdentity({
        serverId: "server",
        callerHash: digest("caller"),
        toolName: "pick_card",
        inventory: generation,
        metadata,
        arguments: {},
      }),
    ).toThrow(expect.objectContaining({ code: "inventory_generation_mismatch" }));
    expect(() => assertClientCapabilities(generation.tools["pick_card"]!, [])).toThrow(
      expect.objectContaining({ code: "client_capability_required" }),
    );
    expect(() =>
      assertClientCapabilities(generation.tools["pick_card"]!, ["elicitation"]),
    ).not.toThrow();
  });
});

describe("provider-neutral sandbox and workspace", () => {
  it("selects the recovery ladder using target restore capabilities", () => {
    const running: SandboxInspection = {
      logicalSandboxId: "logical",
      providerSandboxId: "private",
      sandboxGeneration: "2",
      state: "running",
      workspace: "present",
      capabilities,
    };
    expect(
      chooseSandboxRecovery({
        inspection: running,
        targetCapabilities: capabilities,
        hasCommittedWorkspaceMutation: false,
      }).kind,
    ).toBe("reuse");
    expect(
      chooseSandboxRecovery({
        inspection: { ...running, state: "suspended" },
        targetCapabilities: capabilities,
        hasCommittedWorkspaceMutation: false,
      }).kind,
    ).toBe("resume");
    expect(() =>
      chooseSandboxRecovery({
        inspection: null,
        targetCapabilities: capabilities,
        hasCommittedWorkspaceMutation: true,
      }),
    ).toThrow(expect.objectContaining({ code: "workspace_unavailable" }));
    expect(() =>
      assertSandboxFence(
        { taskId: "task", sandboxGeneration: "2", activationEpoch: 3 },
        { taskId: "task", sandboxGeneration: "1", activationEpoch: 3 },
      ),
    ).toThrow(expect.objectContaining({ code: "sandbox_generation_stale" }));
  });

  it("rejects restore when only the old sandbox advertised checkpoint support", async () => {
    const store = new InMemoryImmutableObjectStore();
    const workspaceVersion = await createWorkspaceVersion({
      store,
      workspaceId: "workspace",
      bytes: new TextEncoder().encode("committed"),
      kind: "full",
      taskId: "task",
      sandboxGeneration: "1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(() =>
      chooseSandboxRecovery({
        inspection: null,
        targetCapabilities: { ...capabilities, checkpointRestore: false },
        latestWorkspaceVersion: workspaceVersion,
        hasCommittedWorkspaceMutation: true,
      }),
    ).toThrow(expect.objectContaining({ code: "workspace_unavailable" }));
  });

  it("materializes and verifies committed workspace bytes before restore", async () => {
    const store = new InMemoryImmutableObjectStore();
    const bytes = new TextEncoder().encode("committed workspace");
    const version = await createWorkspaceVersion({
      store,
      workspaceId: "workspace",
      bytes,
      kind: "full",
      taskId: "task",
      sandboxGeneration: "1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await expect(restoreWorkspaceVersion(store, version)).resolves.toEqual(bytes);
    store.corrupt(version.materialization.object.digest, new Uint8Array([0]));
    await expect(restoreWorkspaceVersion(store, version)).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
  });
});

describe("finite HTTP restore", () => {
  it("preserves accepted pages when restore creation is retried", () => {
    const protocol = new FiniteHttpRestoreProtocol(() => 100);
    const create = restoreCreate();
    const first = protocol.create(create);
    const pageInput = {
      restoreId: first.restoreId,
      pageIndex: 0,
      previousPageDigest: create.replayChainSeed,
      entries: [{ type: "TaskOpened" }] as const,
    };
    const page = { ...pageInput, pageDigest: replayPageDigest(pageInput) };
    expect(protocol.append(page)).toEqual({ status: "accepted" });
    expect(protocol.create(create)).toEqual(first);
    expect(protocol.append(page)).toEqual({ status: "duplicate" });
    expect(
      protocol.finish({
        restoreId: first.restoreId,
        pageCount: 1,
        finalPageDigest: page.pageDigest,
        replayChainDigest: replayChainDigest(create.replayChainSeed, [page.pageDigest]),
      }).entries,
    ).toEqual(page.entries);
  });

  it("rejects gaps, expired restores, and oversized pages", () => {
    let clock = 100;
    const protocol = new FiniteHttpRestoreProtocol(() => clock, {
      pageBytes: 16,
      pageEntries: 1,
      lifetimeMs: 10,
    });
    const create = restoreCreate();
    const { restoreId } = protocol.create(create);
    const pageInput = {
      restoreId,
      pageIndex: 2,
      previousPageDigest: create.replayChainSeed,
      entries: [] as const,
    };
    expect(() =>
      protocol.append({ ...pageInput, pageDigest: replayPageDigest(pageInput) }),
    ).toThrow(expect.objectContaining({ code: "restore_page_out_of_order" }));

    const oversizedInput = {
      restoreId,
      pageIndex: 0,
      previousPageDigest: create.replayChainSeed,
      entries: [{ payload: "larger than sixteen bytes" }],
    };
    expect(() =>
      protocol.append({ ...oversizedInput, pageDigest: replayPageDigest(oversizedInput) }),
    ).toThrow(expect.objectContaining({ code: "payload_too_large" }));

    clock = 110;
    expect(() => protocol.create(create)).not.toThrow();
    clock = 120;
    expect(() => protocol.create(create)).not.toThrow();
    clock = 130;
    const expired = protocol.create(create);
    clock = 140;
    expect(() =>
      protocol.append({
        restoreId: expired.restoreId,
        pageIndex: 0,
        previousPageDigest: create.replayChainSeed,
        entries: [],
        pageDigest: replayPageDigest({
          restoreId: expired.restoreId,
          pageIndex: 0,
          previousPageDigest: create.replayChainSeed,
          entries: [],
        }),
      }),
    ).toThrow(expect.objectContaining({ code: "restore_expired" }));
  });
});
