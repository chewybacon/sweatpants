import { type OperationOutcome } from "@sweatpants/durable-effects";

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { call, createScope, type Operation } from "effection";
import type { AgentDefinition } from "@sweatpants/agent-sdk";
import { sendWebResponse } from "@sweatpants/stream-bridge";
import type { AddressInfo } from "node:net";
import {
  createInMemoryDurableJournalAuthority,
  parseDurableAuthoritySnapshot,
  type CapabilityKeyring,
  type DurableAuthoritySnapshot,
  type DurableSemanticRecord,
  type OpenDurableTaskRequest,
  type ResolveOperationResult,
} from "@sweatpants/journal-authority";
import { sha256, type Json } from "@sweatpants/foundation";
import { type DurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import {
  programDriverSchemaRegistry,
  type ProgramDriverJournal,
  type ProgramDriverJournalStore,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import type {
  BoundStandardA2AHost,
  StandardA2AContinuationBinding,
  StandardA2AEvidence,
  StandardA2AExternalContentBinding,
  StandardA2ATaskDirectory,
  StandardA2ATaskDirectoryEntry,
} from "./standard-a2a-host.ts";
import type { StandardA2AServedAgent } from "./agent-profiles.ts";

export interface StartAgentHarnessOptions {
  readonly agent: StandardA2AServedAgent | BoundStandardA2AHost;
  readonly hostname?: string;
  readonly port?: number;
  readonly discoveryHeaders?: Readonly<Record<string, string>>;
  readonly teardownTimeoutMs?: number;
  /** Loopback-only authenticated evidence route. Absent unless explicitly enabled. */
  readonly checkpoint?: () => Promise<void>;
  readonly evidenceControl?: {
    readonly token: string;
    readonly context: { readonly principalId: string; readonly tenantId?: string };
  };
}

export interface AgentHarness {
  readonly origin: string;
  readonly cardUrl: string;
  readonly interfaceUrl: string;
  readonly host: BoundStandardA2AHost;
  readonly discoveredCard: Json;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  evidence(contextId: string): Promise<StandardA2AEvidence>;
  /** Replaces the real HTTP listener while retaining injected journal/content authorities. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export interface FileProgramDriverJournalStore extends ProgramDriverJournalStore {
  checkpoint(): Promise<void>;
}

/** Persistent reference store used by process-replacement certification. */
export function createFileProgramDriverJournalStore(options: {
  readonly directory: string;
  readonly keyring: CapabilityKeyring;
  /** Prefer the authored agent; its complete schema inventory is derived automatically. */
  readonly agent?: AgentDefinition;
  /** Low-level escape hatch for stores not associated with one authored agent. */
  readonly schemaRegistry?: DurableSchemaRegistry;
  readonly journalPrefix?: string;
  readonly now?: () => number;
}): FileProgramDriverJournalStore {
  if (options.agent && options.schemaRegistry) {
    throw new Error("Specify agent or schemaRegistry, not both");
  }
  const schemaRegistry = options.agent
    ? programDriverSchemaRegistry(options.agent.bindings.schemas)
    : options.schemaRegistry;
  if (!schemaRegistry) {
    throw new Error("A file journal store requires an agent or schemaRegistry");
  }
  const authorities = new Map<string, ReturnType<typeof createInMemoryDurableJournalAuthority>>();
  const fileFor = (conversationId: string) =>
    `${options.directory}/${sha256(conversationId)}.journal.json`;
  const load = async (conversationId: string) => {
    const existing = authorities.get(conversationId);
    if (existing) {
      return existing;
    }
    let snapshot: DurableAuthoritySnapshot | undefined;
    try {
      snapshot = parseDurableAuthoritySnapshot(await readFile(fileFor(conversationId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const authority = createInMemoryDurableJournalAuthority({
      journalId: `${options.journalPrefix ?? "standard-a2a-file"}:${conversationId}`,
      journalIncarnation: "1",
      keyring: options.keyring,
      schemaRegistry,
      ...(options.now ? { now: options.now } : {}),
      ...(snapshot ? { snapshot } : {}),
    });
    authorities.set(conversationId, authority);
    return authority;
  };
  return {
    *open(conversationId): Operation<ProgramDriverJournal> {
      const authority = yield* call(() => load(conversationId));
      return {
        authority,
        *openTask(request: OpenDurableTaskRequest): Operation<void> {
          yield* authority.openTask(request);
        },
        *executionState(sessionId, taskId) {
          return yield* authority.taskExecutionState(sessionId, taskId);
        },
        *recoveryState(sessionId, requestedTaskId) {
          return yield* authority.taskRecoveryState(sessionId, requestedTaskId);
        },
        *rootTaskCount(sessionId) {
          return yield* authority.rootTaskCount(sessionId);
        },
        *operationState(sessionId, taskId, pullId) {
          return yield* authority.operationState(sessionId, taskId, pullId);
        },
        *replaceAttachment(sessionId, taskId, attachmentId) {
          const replaced = yield* authority.replaceAttachment(
            sessionId,
            taskId,
            attachmentId,
            "program-runtime",
          );
          return { executionEpoch: replaced.executionEpoch };
        },
        *readJournal(sessionId: string): Operation<DurableSemanticRecord[]> {
          return authority.readJournal(sessionId);
        },
        *requestCancellation(sessionId: string, taskId: string, reason?: string): Operation<void> {
          yield* authority.requestCancellation(sessionId, taskId, reason);
        },
        *resolvePending(request: {
          sessionId: string;
          taskId: string;
          pullId: string;
          audience: string;
          outcome: OperationOutcome;
        }): Operation<ResolveOperationResult> {
          return yield* authority.resolve({
            capability: authority.resolutionCapability(
              request.sessionId,
              request.taskId,
              request.pullId,
            ),
            audience: request.audience,
            outcome: request.outcome,
          });
        },
      };
    },
    async checkpoint() {
      await mkdir(options.directory, { recursive: true });
      await Promise.all(
        [...authorities].map(async ([conversationId, authority]) => {
          const path = fileFor(conversationId);
          const temporary = `${path}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify(authority.exportSnapshot()), { mode: 0o600 });
          await rename(temporary, path);
        }),
      );
    },
  };
}

export function createFileStandardA2ATaskDirectory(path: string): StandardA2ATaskDirectory {
  type State = {
    version: 1;
    tasks: Record<string, StandardA2ATaskDirectoryEntry>;
    continuations: Record<string, StandardA2AContinuationBinding>;
    content: Record<string, StandardA2AExternalContentBinding>;
  };
  let state: State | undefined;
  let mutation = Promise.resolve();
  const load = async (): Promise<State> => {
    if (state) {
      return state;
    }
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as State;
      if (parsed.version !== 1 || !parsed.tasks || !parsed.continuations || !parsed.content) {
        throw new Error();
      }
      state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Persistent A2A task directory is invalid", { cause: error });
      }
      state = { version: 1, tasks: {}, continuations: {}, content: {} };
    }
    return state;
  };
  const persist = async (next: State): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, path);
  };
  const mutate = <T>(operation: (current: State) => Promise<T> | T): Promise<T> => {
    const result = mutation.then(async () => {
      const current = await load();
      const value = await operation(current);
      await persist(current);
      return value;
    });
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    *bind(entry) {
      return yield* call(() =>
        mutate((current) => {
          const existing = current.tasks[entry.taskId];
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(entry)) {
              throw new Error("Persistent task directory identity conflict");
            }
            return "duplicate" as const;
          }
          current.tasks[entry.taskId] = structuredClone(entry);
          return "bound" as const;
        }),
      );
    },
    *lookup(taskId) {
      yield* call(() => mutation);
      return structuredClone((yield* call(() => load())).tasks[taskId]);
    },
    *bindContinuation(binding) {
      return yield* call(() =>
        mutate((current) => {
          const key = `${binding.taskId}\0${binding.messageId}`;
          const existing = current.continuations[key];
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(binding)) {
              throw new Error("Persistent continuation identity conflict");
            }
            return "duplicate" as const;
          }
          current.continuations[key] = structuredClone(binding);
          return "bound" as const;
        }),
      );
    },
    *lookupContinuation(taskId, messageId) {
      yield* call(() => mutation);
      return structuredClone((yield* call(() => load())).continuations[`${taskId}\0${messageId}`]);
    },
    *continuationsForTask(taskId) {
      yield* call(() => mutation);
      return Object.values((yield* call(() => load())).continuations).filter(
        (binding) => binding.taskId === taskId,
      );
    },
    *bindContent(binding) {
      return yield* call(() =>
        mutate((current) => {
          const key = `${binding.taskId}\0${binding.artifactId}\0${binding.partIndex}`;
          const existing = current.content[key];
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(binding)) {
              throw new Error("Persistent content association conflict");
            }
            return "duplicate" as const;
          }
          current.content[key] = structuredClone(binding);
          return "bound" as const;
        }),
      );
    },
    *contentForTask(taskId) {
      yield* call(() => mutation);
      return Object.values((yield* call(() => load())).content).filter(
        (binding) => binding.taskId === taskId,
      );
    },
    *lookupContent(digest) {
      yield* call(() => mutation);
      return Object.values((yield* call(() => load())).content).find(
        (binding) => binding.reference.digest === digest,
      );
    },
    *check() {
      yield* call(() => mutation);
      yield* call(() => load());
    },
  };
}

/**
 * Real-loopback development harness. All certification traffic crosses TCP/HTTP;
 * direct host calls are exposed only for content-safe evidence inspection.
 */
export async function startAgentHarness(options: StartAgentHarnessOptions): Promise<AgentHarness> {
  const host = boundHost(options.agent);
  const hostname = options.hostname ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(hostname)) {
    throw new Error("Agent harness binds loopback only");
  }
  const createListener = () =>
    createServer((request, response) => {
      void handleNodeRequest(host, request, response, options.evidenceControl, options.checkpoint);
    });
  let server = createListener();
  await listen(server, options.port ?? 0, hostname);
  const address = server.address() as AddressInfo;
  const selectedPort = address.port;
  const origin = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  const cardUrl = `${origin}/.well-known/agent-card.json`;
  const interfaces = (host.card as Record<string, Json>)["supportedInterfaces"] as Array<
    Record<string, Json>
  >;
  const interfacePath = new URL(String(interfaces[0]!["url"])).pathname;
  const interfaceUrl = `${origin}${interfacePath}`;
  const discovery = await fetch(
    cardUrl,
    options.discoveryHeaders ? { headers: options.discoveryHeaders } : {},
  );
  if (!discovery.ok) {
    await closeServer(server, options.teardownTimeoutMs ?? 5_000);
    throw new Error(`Agent harness discovery failed with status ${discovery.status}`);
  }
  const discoveredCard = (await discovery.json()) as Json;
  let stopped = false;
  return Object.freeze({
    origin,
    cardUrl,
    interfaceUrl,
    host,
    discoveredCard,
    fetch(path: string, init?: RequestInit) {
      return fetch(new URL(path, origin), init);
    },
    async evidence(contextId: string) {
      if (!options.evidenceControl) {
        throw new Error("Harness evidence control is not enabled");
      }
      const response = await fetch(
        `${origin}/__sweatpants/evidence/${encodeURIComponent(contextId)}`,
        { headers: { authorization: `Bearer ${options.evidenceControl.token}` } },
      );
      if (!response.ok) {
        throw new Error(`Harness evidence request failed with status ${response.status}`);
      }
      return (await response.json()) as StandardA2AEvidence;
    },
    async restart() {
      await closeServer(server, options.teardownTimeoutMs ?? 5_000);
      server = createListener();
      await listen(server, selectedPort, hostname);
      await waitForHarnessReady(cardUrl, options.discoveryHeaders);
      stopped = false;
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await closeServer(server, options.teardownTimeoutMs ?? 5_000);
    },
  });
}

function boundHost(agent: StandardA2AServedAgent | BoundStandardA2AHost): BoundStandardA2AHost {
  const candidate = "posture" in agent ? agent.host : agent;
  if (!candidate || !("handle" in candidate) || typeof candidate.handle !== "function") {
    throw new Error("startAgentHarness requires a bound standard A2A task host");
  }
  return candidate as BoundStandardA2AHost;
}

async function handleNodeRequest(
  host: BoundStandardA2AHost,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  evidenceControl?: StartAgentHarnessOptions["evidenceControl"],
  checkpoint?: StartAgentHarnessOptions["checkpoint"],
): Promise<void> {
  try {
    const evidenceMatch = /^\/__sweatpants\/evidence\/([^/?]+)$/.exec(
      incoming.url?.split("?")[0] ?? "",
    );
    if (evidenceMatch) {
      if (
        !evidenceControl ||
        incoming.headers.authorization !== `Bearer ${evidenceControl.token}` ||
        !["127.0.0.1", "::1"].includes(incoming.socket.remoteAddress ?? "")
      ) {
        outgoing.statusCode = 404;
        outgoing.end();
        return;
      }
      const [scope, destroyScope] = createScope();
      let evidence: StandardA2AEvidence;
      try {
        evidence = await scope.run(function* () {
          return yield* host.evidence(
            decodeURIComponent(evidenceMatch[1]!),
            evidenceControl.context,
          );
        });
      } finally {
        await destroyScope();
      }
      outgoing.statusCode = 200;
      outgoing.setHeader("content-type", "application/json");
      // Persist before acknowledging: a response must never claim state that
      // a process replacement could lose.
      await checkpoint?.();
      outgoing.end(JSON.stringify(evidence));
      return;
    }
    const address = incoming.socket.localAddress ?? "127.0.0.1";
    const hostHeader = incoming.headers.host ?? `${address}:${incoming.socket.localPort}`;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        value.forEach((item) => headers.append(name, item));
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const method = incoming.method ?? "GET";
    const response = await host.handle(
      new Request(`http://${hostHeader}${incoming.url ?? "/"}`, {
        method,
        headers,
        ...(!["GET", "HEAD"].includes(method) && body.byteLength > 0 ? { body } : {}),
      }),
    );
    // Persist before acknowledging: a response must never claim state that a
    // process replacement could lose (e.g. a parked input_required task).
    await checkpoint?.();
    await sendWebResponse(outgoing, response);
  } catch {
    if (!outgoing.headersSent) {
      outgoing.statusCode = 500;
    }
    outgoing.end(
      '{"error":{"code":"harness_transport_error","message":"Harness transport failed"}}',
    );
  }
}
async function waitForHarnessReady(
  cardUrl: string,
  headers?: Readonly<Record<string, string>>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(cardUrl, {
        headers: { ...headers, connection: "close" },
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`Harness readiness returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Restarted agent harness did not become ready", { cause: lastError });
}
function listen(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
async function closeServer(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Agent harness teardown timed out")), timeoutMs),
    ),
  ]);
}
