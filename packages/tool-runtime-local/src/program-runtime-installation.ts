import type { AnyToolContract } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import type { ToolRuntime } from "@sweatpants/tool-runtime";
import { installLocalToolRuntime, type LocalToolRuntimeDriverOptions } from "./driver.ts";
import {
  createToolInvocationForeignEffectRegistrations,
  type ToolInvocationForeignEffectRegistrations,
} from "./foreign-tool-session.ts";

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
    installForeignEffects(registrations: ToolInvocationForeignEffectRegistrations): Operation<void>;
  },
): Operation<ToolRuntime> {
  // Install first so worker-mode and duplicate-tool validation fail before any
  // foreign-effect context is published.
  const runtime = yield* installLocalToolRuntime(options);
  yield* options.installForeignEffects(
    createToolInvocationForeignEffectRegistrations({
      tools: new Map(options.tools.map((tool: AnyToolContract) => [tool.name, tool])),
    }),
  );
  return runtime;
}
