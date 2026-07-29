import type { Operation } from "effection";
import {
  acceptChatTurn,
  createChatModelEffectRegistration,
  type ChatMessageV1,
  type ChatModelSampleInputV2,
  type ChatModelSampleOutputV2,
} from "@sweatpants/chat-core";
import {
  createInMemoryProgramDriverJournalStore,
  createLocalProgramHost,
  createPinnedProgramCatalog,
  programDriverSchemaRegistry,
  type LocalProgramHost,
  type NormalizedProgramTrace,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import { createDurableToolRegistry, createLocalProgramDriver } from "@sweatpants/durable-execution";
import { type Json } from "@sweatpants/foundation";
import { createProgramDriverRegistry } from "@sweatpants/durable-execution";
import {
  installLocalWorkspaceFilesProvider,
  installRemoteWorkspaceFilesProvider,
  type WorkspaceConnector,
  type WorkspaceFence,
  type WorkspaceOperations,
} from "@sweatpants/workspace-runtime";

import { codingCapabilities } from "../capabilities/index.ts";
import { codingHarness } from "../programs/coding-harness.ts";

export interface CodingTaskRequest {
  readonly task: string;
  readonly workspaceRevision: string;
}

export interface CodingTaskResult {
  readonly sessionId: string;
  readonly taskId: string;
  readonly state: "completed" | "failed" | "cancelled" | "parked";
  readonly value?: unknown;
  readonly trace: NormalizedProgramTrace;
}

export interface CodingModelSampleProvider {
  sample(request: ChatModelSampleInputV2): Operation<ChatModelSampleOutputV2>;
}

export interface HeadlessCodingService {
  start(request: CodingTaskRequest): Operation<CodingTaskResult>;
  trace(sessionId: string): Operation<NormalizedProgramTrace>;
}

/**
 * Creates the finite-request coding service over the existing LocalProgramHost.
 * A production composition swaps only the journal store and model service.
 */
export function createHeadlessCodingService(options: {
  readonly connector?: WorkspaceConnector;
  readonly operations?: WorkspaceOperations;
  readonly fence: WorkspaceFence;
  readonly modelSamplingProvider?: CodingModelSampleProvider;
}): HeadlessCodingService {
  const definitions = [codingHarness, ...Object.values(codingCapabilities)];
  const programs = createDurableToolRegistry(definitions);
  const schemas = definitions.flatMap((definition) => {
    if ("schemaCatalog" in definition) {
      return [...definition.schemaCatalog];
    }
    return [...definition.artifacts.catalog];
  });
  const modelSamplingProvider =
    options.modelSamplingProvider ?? createScriptedCodingModelSampleProvider();
  const installWorkspace = function* (): Operation<void> {
    if (options.operations) {
      yield* installLocalWorkspaceFilesProvider({
        resolve: function* () {
          return { operations: options.operations!, fence: options.fence };
        },
      });
    } else {
      if (!options.connector) {
        throw new Error("workspace provider is not configured");
      }
      yield* installRemoteWorkspaceFilesProvider({
        resolve: function* () {
          return { connector: options.connector!, fence: options.fence };
        },
      });
    }
  };
  const host: LocalProgramHost = createLocalProgramHost({
    journalStore: createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring("yo-studio-headless", [
        { keyId: "active", secret: "yo-studio-headless-development-secret" },
      ]),
      schemaRegistry: programDriverSchemaRegistry(schemas),
    }),
    programs,
    effects: createDurableEffectRegistry([
      createChatModelEffectRegistration({
        allowedClassifications: ["public", "internal"],
        *sample(request) {
          return yield* modelSamplingProvider.sample(request);
        },
      }),
    ]),
    drivers: createProgramDriverRegistry([
      ["program", createLocalProgramDriver(programs, { setup: installWorkspace })],
    ]),
  });
  const rootPin = pin(codingHarness);
  const catalog = createPinnedProgramCatalog({
    code: { kind: "program", target: "code", program: rootPin },
    ...Object.fromEntries(
      Object.entries(codingCapabilities).map(([target, definition]) => [
        target,
        { kind: "program", target, program: pin(definition) },
      ]),
    ),
  });

  return {
    *start(request) {
      const message: ChatMessageV1 = {
        id: "task-message",
        role: "user",
        parts: [
          {
            value: `${request.task}\n\nWorkspace binding: ${JSON.stringify({ workspaceRevision: request.workspaceRevision })}`,
            provenance: { classifications: [], sourceDigests: [] },
          },
        ],
      };
      const opened = yield* host.open({
        program: rootPin,
        manifest: codingHarness.manifest,
        input: acceptChatTurn(codingHarness.contextPolicy, message, {
          frontier: "initial",
          messages: [],
        }) as unknown as Json,
        catalog,
        route: { driverKind: "program", location: "host" },
      });
      const outcome = yield* opened.result;
      return {
        sessionId: opened.sessionId,
        taskId: opened.taskId,
        state: outcome.state,
        ...(outcome.state === "completed" ? { value: outcome.value } : {}),
        trace: yield* host.trace(opened.sessionId),
      };
    },
    *trace(sessionId) {
      return yield* host.trace(sessionId);
    },
  };
}

/** Deterministic demo model; production injects the deployment's model service. */
export function createScriptedCodingModelSampleProvider(): CodingModelSampleProvider {
  return {
    *sample(request) {
      const transcript = JSON.stringify(request.messages);
      const versions = [...transcript.matchAll(/[a-f0-9]{64}/g)].map((match) => match[0]);
      const workspaceRevision = versions.at(-1);
      if (!workspaceRevision) {
        throw new Error("scripted coding model could not find a workspace version");
      }
      if (!transcript.includes('"bytes":29')) {
        return sampleResult("Writing the requested demonstration file.", [
          {
            id: "write-demo",
            target: "workspace_write",
            input: {
              path: "demo.txt",
              contents: "hello from durable yo-studio\n",
              expectedWorkspaceRevision: workspaceRevision,
            },
          },
        ]);
      }
      if (!transcript.includes('"exitCode":0')) {
        return sampleResult("Running the declared test script.", [
          {
            id: "test-demo",
            target: "workspace_test",
            input: { script: "test", expectedWorkspaceRevision: workspaceRevision },
          },
        ]);
      }
      return sampleResult("Created demo.txt and the declared test script passed.", []);
    },
  };
}

function sampleResult(
  text: string,
  calls: ChatModelSampleOutputV2["calls"],
): ChatModelSampleOutputV2 {
  return {
    message: {
      id: `scripted-${calls.length > 0 ? calls[0]!.id : "complete"}`,
      role: "assistant",
      parts: [
        {
          value: text,
          provenance: { classifications: ["internal"], sourceDigests: [] },
        },
      ],
    },
    calls,
    artifacts: [],
  };
}

function pin(definition: {
  readonly manifest: { programId: string; version: string; digest: string };
}) {
  return {
    id: definition.manifest.programId,
    version: definition.manifest.version,
    digest: definition.manifest.digest,
  };
}
