import type { AgentCoreRuntimeRelease } from "@sweatpants/tool-runtime-agentcore";
import type { AnyToolContract, RuntimeTool } from "@sweatpants/core";
import type { Operation } from "effection";
import {
  PluginSessionManagerContext,
  PluginSessionRegistryContext,
  ToolInventoryContext,
  installToolRuntime,
  createStrategyToolRuntime,
  createToolInventory,
  createToolInventoryEntry,
  projectAvailableToolContracts,
} from "@sweatpants/framework/chat";
import {
  ProgramDriverForeignEffectsContext,
  ProgramDriverNativeToolsContext,
  programDriverSchemaRegistry,
  type PluginSessionManager,
} from "@sweatpants/framework/server";
import {
  createDurableToolRegistry,
  type ProgramDriver,
  type ProgramRoute,
} from "@sweatpants/durable-execution";
import { type Json } from "@sweatpants/foundation";
import type { ToolSessionRegistry, ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import {
  createLocalWorkerDurableProgramDriver,
  createToolSessionForeignEffectRegistrations,
  installLocalProgramToolRuntime,
} from "@sweatpants/tool-runtime-local";
import {
  createAgentCoreToolExecutionStrategy,
  exactProgramKey,
  reconcileAgentCoreDurableReadiness,
} from "@sweatpants/tool-runtime-agentcore";

import { pickCard } from "../tools/pick-card/durable";
import { createDrawPickCardsRegistration } from "../tools/pick-card/durable-effects";
import { playTttTool } from "../tools/play-ttt/tool";
import { yoChatDurableProgramWorkerUrl } from "./tool-worker-config";

/** Explicit dependencies for installing one complete yo-chat tool runtime. */
export interface YoChatToolRuntimeInstallation {
  mode: "local" | "agentcore";
  registry: ToolSessionRegistry;
  pluginManager: PluginSessionManager;
  samplingProvider: ToolSessionSamplingProvider;
  tools: AnyToolContract[];
  /** Explicit immutable durable release readiness. Absence safely omits pick_card. */
  agentCoreDurable?: {
    readonly journalId: string;
    readonly release: AgentCoreRuntimeRelease;
    readonly driver: ProgramDriver;
    readonly availablePrograms: ReadonlySet<string>;
    readonly availableEffects: ReadonlySet<string>;
    readonly availableSchemaDigests: ReadonlySet<string>;
    readonly developmentPrograms?: readonly {
      readonly publicKey: string;
      readonly tool: typeof pickCard | typeof playTttTool;
      readonly collection: Json;
      readonly evaluatorAbi: string;
    }[];
  };
}

/**
 * Installs the entire tool inventory into exactly one execution runtime. Local
 * mode uses one worker-backed registry; AgentCore mode uses one remote registry.
 */
export function* installYoChatToolRuntime(options: YoChatToolRuntimeInstallation): Operation<void> {
  const developmentPrograms = options.agentCoreDurable?.developmentPrograms;
  const runtimeTools = developmentPrograms
    ? options.tools.map(
        (tool) => developmentPrograms.find((entry) => entry.tool.name === tool.name)?.tool ?? tool,
      )
    : options.tools;
  const ordinaryContracts = runtimeTools.filter((tool) => tool.execution !== "crank_native");
  const ordinaryTools = ordinaryContracts.filter(
    (tool): tool is RuntimeTool => typeof tool === "function",
  );
  const durablePrograms =
    options.mode === "agentcore" && developmentPrograms
      ? developmentPrograms.map((entry) => entry.tool)
      : [pickCard, playTttTool];
  const schemaRegistry = programDriverSchemaRegistry(
    durablePrograms.flatMap((tool) => [...tool.artifacts.catalog]),
  );
  const programIdentities = new Map(
    durablePrograms.map((tool) => [
      tool.name,
      exactProgramKey({
        id: tool.manifest.programId,
        version: tool.manifest.version,
        digest: tool.manifest.digest,
      }),
    ]),
  );
  const readyDurableNames = new Set<string>();
  if (options.mode === "local") {
    for (const tool of durablePrograms) {
      readyDurableNames.add(tool.name);
    }
  } else if (options.agentCoreDurable) {
    for (const tool of durablePrograms) {
      const identity = programIdentities.get(tool.name)!;
      const readiness = reconcileAgentCoreDurableReadiness({
        release: options.agentCoreDurable.release,
        program: {
          id: tool.manifest.programId,
          version: tool.manifest.version,
          digest: tool.manifest.digest,
        },
        registry: new Map(
          options.agentCoreDurable.availablePrograms.has(identity)
            ? [[identity, tool.manifest]]
            : [],
        ),
        driverAvailable: true,
        effectKeys: options.agentCoreDurable.availableEffects,
        schemaDigests: options.agentCoreDurable.availableSchemaDigests,
        manifest: tool.manifest,
      });
      console.info("[yo-chat] durable AgentCore readiness", {
        program: tool.name,
        identity,
        ready: readiness.ready,
        missing: readiness.missing,
        schemaCatalogSize: options.agentCoreDurable.availableSchemaDigests.size,
        missingSchemaDigests: manifestSchemaDigests(tool).filter(
          (digest) => !options.agentCoreDurable!.availableSchemaDigests.has(digest),
        ),
        developmentCollection: developmentPrograms !== undefined,
      });
      if (readiness.ready) {
        readyDurableNames.add(tool.name);
      }
    }
  }
  const driverKind = options.mode === "local" ? "worker" : "agentcore";
  const readyPrograms = durablePrograms.filter((tool) => readyDurableNames.has(tool.name));
  const availableContracts = projectAvailableToolContracts(runtimeTools, {
    ordinaryTools: new Set(ordinaryContracts.map((tool) => tool.name)),
    drivers: new Set(readyPrograms.length > 0 ? [driverKind] : []),
    programs: new Set(readyPrograms.map((tool) => programIdentities.get(tool.name)!)),
    effects: new Set(
      readyPrograms.flatMap((tool) =>
        Object.values(tool.manifest.effects).map((effect) => `${effect.name}@${effect.version}`),
      ),
    ),
    schemas: schemaRegistry,
    durableDrivers: new Map(readyPrograms.map((tool) => [tool.name, driverKind])),
  });
  yield* PluginSessionRegistryContext.set(options.registry);
  yield* PluginSessionManagerContext.set(options.pluginManager);
  yield* ToolInventoryContext.set(
    createToolInventory(availableContracts.map((tool) => createToolInventoryEntry(tool))),
  );
  if (options.mode === "local") {
    const durableRegistry = createDurableToolRegistry(durablePrograms);
    yield* ProgramDriverNativeToolsContext.set({
      bindings: new Map(
        durablePrograms.map((tool) => [
          tool.name,
          {
            publicName: tool.name,
            tool,
            route: { driverKind: "worker", profile: "yo-chat-durable-tools" },
          },
        ]),
      ),
      drivers: [
        [
          "worker",
          createLocalWorkerDurableProgramDriver({
            workerUrl: yoChatDurableProgramWorkerUrl,
            name: "yo-chat-durable-program",
            registry: durableRegistry,
          }),
        ],
      ],
      effects: [createDrawPickCardsRegistration()],
    });
  }

  if (options.mode === "agentcore") {
    // Remote ordinary-tool execution still uses the ToolSession foreign-effect
    // adapter for durable child sampling; only local composition is folded into
    // installLocalProgramToolRuntime.
    yield* ProgramDriverForeignEffectsContext.set(
      createToolSessionForeignEffectRegistrations({
        registry: options.registry,
        tools: new Map(ordinaryTools.map((tool) => [tool.name, tool])),
      }),
    );
    if (readyPrograms.length > 0 && options.agentCoreDurable) {
      const agentCoreDurable = options.agentCoreDurable;
      yield* ProgramDriverNativeToolsContext.set({
        bindings: new Map(
          readyPrograms.map((tool) => [
            tool.name,
            {
              publicName: tool.name,
              tool,
              // AgentCore evaluates programs in a remote substrate; declare the
              // activation-safety capability instead of relying on driverKind.
              activation: "fenced",
              route: {
                driverKind: "agentcore",
                journalId: agentCoreDurable.journalId,
                release: agentCoreDurable.release,
                ...(developmentPrograms
                  ? {
                      development: {
                        collection: developmentPrograms.find(
                          (entry) => entry.tool.name === tool.name,
                        )!.collection,
                        publicKey: developmentPrograms.find(
                          (entry) => entry.tool.name === tool.name,
                        )!.publicKey,
                        evaluatorAbi: developmentPrograms.find(
                          (entry) => entry.tool.name === tool.name,
                        )!.evaluatorAbi,
                      },
                    }
                  : {}),
              } as unknown as ProgramRoute,
            },
          ]),
        ),
        drivers: [["agentcore", agentCoreDurable.driver]],
        effects: [createDrawPickCardsRegistration()],
      });
    }
    yield* installToolRuntime(
      createStrategyToolRuntime({
        id: "agentcore",
        strategies: [
          createAgentCoreToolExecutionStrategy({
            tools: ordinaryContracts as RuntimeTool[],
            registry: options.registry,
            samplingProvider: options.samplingProvider,
          }),
        ],
      }),
    );
    return;
  }

  yield* installLocalProgramToolRuntime({
    tools: ordinaryTools,
    registry: options.registry,
    samplingProvider: options.samplingProvider,
  });
}

function manifestSchemaDigests(tool: typeof pickCard | typeof playTttTool): string[] {
  return [
    tool.manifest.inputSchema.digest,
    tool.manifest.outputSchema.digest,
    ...Object.values(tool.manifest.elicits).flatMap((elicit) => [
      elicit.response.digest,
      ...(elicit.context ? [elicit.context.digest] : []),
    ]),
    ...Object.values(tool.manifest.effects).flatMap((effect) => [
      effect.inputSchema.digest,
      effect.outputSchema.digest,
      ...(effect.cancellation ? [effect.cancellation.partialSchema.digest] : []),
    ]),
  ];
}
