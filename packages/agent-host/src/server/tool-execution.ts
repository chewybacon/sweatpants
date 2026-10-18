import {
  isChatDurableTool,
  installInvocationToolRuntime,
  createToolInvocationEphemeralEffectRegistrations,
  type ChatTool,
  type ToolExecutionAdapter,
  type ToolExecutionBinding,
} from "@sweatpants/tool-session/execution";
import { canonicalJson } from "@sweatpants/foundation";
import { durableEffectKey, type DurableEffectRegistration } from "@sweatpants/durable-effects";
import {
  ProgramDriverNativeToolsContext,
  ProgramDriverEphemeralEffectsContext,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import {
  createToolInventory,
  createToolInventoryEntry,
  installToolInventory,
} from "@sweatpants/tool-runtime";
import {
  createToolInvocationHost,
  ToolInvocationHostPort,
  ToolInvocationEventSourcePort,
  type ToolSessionSamplingProvider,
} from "@sweatpants/tool-session";
import type { Operation } from "effection";
import { createModelSamplingProvider } from "./model-sampling.ts";

export function prepareChatTools(
  tools: readonly ChatTool[],
  execution: ToolExecutionAdapter | undefined,
  effects: readonly DurableEffectRegistration[],
) {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    names.add(tool.name);
    if (tool.execution === "crank_native" && !isChatDurableTool(tool)) {
      throw new Error(`Durable tool requires its authored program: ${tool.name}`);
    }
  }
  const effectKeys = new Set<string>();
  for (const effect of effects) {
    const key = durableEffectKey(effect.definition.name, effect.definition.version);
    if (effectKeys.has(key)) {
      throw new Error(`Duplicate effect handler: ${key}`);
    }
    effectKeys.add(key);
  }
  for (const tool of tools.filter(isChatDurableTool)) {
    for (const effect of Object.values(tool.manifest.effects)) {
      const key = durableEffectKey(effect.name, effect.version);
      if (!effectKeys.has(key)) {
        throw new Error(
          `Tool ${tool.name} requires effect handler: ${effect.name}@${effect.version}`,
        );
      }
      const registration = effects.find(
        (entry) => durableEffectKey(entry.definition.name, entry.definition.version) === key,
      )!;
      if (canonicalJson(registration.definition) !== canonicalJson(effect)) {
        throw new Error(
          `Effect handler contract mismatch for ${tool.name}: ${effect.name}@${effect.version}`,
        );
      }
    }
  }
  if (tools.length && !execution) {
    throw new Error(
      "Tools require an execution adapter; configure local({ worker, durableWorker }) or routeTools(...)",
    );
  }
  const prepared = execution?.prepare(tools, "tools") ?? {};
  const bindings = new Map<string, ToolExecutionBinding>();
  const drivers = new Map(prepared.drivers ?? []);
  const driverNames = new Set([
    ...drivers.keys(),
    ...(prepared.driverFactories ?? []).map(([name]) => name),
  ]);
  if (
    driverNames.size !==
    (prepared.drivers?.length ?? 0) + (prepared.driverFactories?.length ?? 0)
  ) {
    throw new Error("Duplicate durable execution driver");
  }
  for (const binding of prepared.bindings ?? []) {
    if (bindings.has(binding.publicName)) {
      throw new Error(`Duplicate durable binding: ${binding.publicName}`);
    }
    if (!tools.includes(binding.tool) || binding.publicName !== binding.tool.name) {
      throw new Error(`Invalid durable binding: ${binding.publicName}`);
    }
    const route = binding.route;
    const driverKind =
      route && typeof route === "object" && !Array.isArray(route) ? route.driverKind : undefined;
    if (
      typeof driverKind !== "string" ||
      (driverKind !== "program" && !driverNames.has(driverKind))
    ) {
      throw new Error(`Missing durable driver for: ${binding.publicName}`);
    }
    bindings.set(binding.publicName, binding);
  }
  for (const tool of tools.filter(isChatDurableTool)) {
    if (!bindings.has(tool.name)) {
      throw new Error(`No durable execution binding for: ${tool.name}`);
    }
  }
  if (tools.some((t) => !isChatDurableTool(t)) && !prepared.createResources) {
    throw new Error("Execution adapter does not provide ordinary tool resources");
  }
  return {
    programs: tools.filter(isChatDurableTool),
    *install(samplingProvider: ToolSessionSamplingProvider): Operation<void> {
      yield* installToolInventory(
        createToolInventory(tools.map((tool) => createToolInventoryEntry(tool))),
      );
      const installedDrivers = [...drivers];
      for (const [name, create] of prepared.driverFactories ?? []) {
        const driver = yield* create();
        installedDrivers.push([name, driver]);
      }
      yield* ProgramDriverNativeToolsContext.set({
        bindings,
        drivers: installedDrivers,
        effects,
        setup: prepared.setup,
      });
      const ordinary = tools.filter((tool) => !isChatDurableTool(tool));
      if (prepared.createResources) {
        const factory = yield* prepared.createResources();
        yield* ToolInvocationHostPort.installDriver(createToolInvocationHost(factory));
        yield* ToolInvocationEventSourcePort.installDriver({
          *open(id) {
            return (yield* factory.open(id))?.projection ?? null;
          },
        });
      }
      yield* installInvocationToolRuntime({
        id: prepared.runtimeId,
        tools: [...ordinary],
        samplingProvider,
      });
      yield* ProgramDriverEphemeralEffectsContext.set(
        createToolInvocationEphemeralEffectRegistrations({
          tools: new Map(ordinary.map((t) => [t.name, t])),
        }),
      );
    },
  };
}

/** Advanced scoped composition for hosts that own their application lifecycle. */
export function* installChatTools(options: {
  tools: readonly ChatTool[];
  execution: ToolExecutionAdapter;
  effects?: readonly DurableEffectRegistration[];
  samplingProvider?: ToolSessionSamplingProvider;
}): Operation<void> {
  yield* prepareChatTools(options.tools, options.execution, options.effects ?? []).install(
    options.samplingProvider ?? createModelSamplingProvider(),
  );
}

/** Advanced durable-program placement in the existing host crank, with scoped capabilities. */
export function inProcess(options: { setup?: () => Operation<void> } = {}): ToolExecutionAdapter {
  return {
    prepare(tools) {
      if (tools.some((tool) => !isChatDurableTool(tool))) {
        throw new Error(
          "inProcess accepts durable programs only; ordinary tools require a worker runtime",
        );
      }
      return {
        setup: options.setup,
        bindings: tools
          .filter(isChatDurableTool)
          .map((tool) => ({ publicName: tool.name, tool, route: { driverKind: "program" } })),
      };
    },
  };
}
