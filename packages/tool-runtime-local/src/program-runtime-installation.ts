import type { RuntimeTool } from "@sweatpants/core";
import type { Operation } from "effection";
import type { ToolRuntime } from "@sweatpants/framework/chat";
import { ProgramDriverForeignEffectsContext } from "@sweatpants/framework/server";
import { installLocalToolRuntime, type LocalToolRuntimeDriverOptions } from "./driver.ts";
import { createToolSessionForeignEffectRegistrations } from "./foreign-tool-session.ts";

/**
 * Installs the worker-backed local tool runtime together with the durable
 * Program Runtime foreign-effect adapter that uses the same registry and tool
 * contracts.
 *
 * Use this composition helper when ordinary local tools can be invoked from a
 * durable program (including tools that call ctx.sample()). Applications that
 * only need the ordinary chat ToolRuntime should use installLocalToolRuntime.
 */
export function* installLocalProgramToolRuntime(
  options: LocalToolRuntimeDriverOptions & {
    registry: NonNullable<LocalToolRuntimeDriverOptions["registry"]>;
  },
): Operation<ToolRuntime> {
  // Install first so worker-mode and duplicate-tool validation fail before any
  // foreign-effect context is published.
  const runtime = yield* installLocalToolRuntime(options);
  yield* ProgramDriverForeignEffectsContext.set(
    createToolSessionForeignEffectRegistrations({
      registry: options.registry,
      tools: new Map(options.tools.map((tool: RuntimeTool) => [tool.name, tool])),
    }),
  );
  return runtime;
}
