import type { AnyToolContract } from "@sweatpants/agent-sdk";
import type { Operation } from "effection";
import type { ToolRuntime } from "@sweatpants/tool-runtime";
import { installInvocationToolRuntime, type InvocationToolRuntimeDriverOptions } from "./driver.ts";
import {
  createToolInvocationEphemeralEffectRegistrations,
  type ToolInvocationEphemeralEffectRegistrations,
} from "./ephemeral-tool-session.ts";

/** Installs invocation orchestration and durable ephemeral effects over the configured host. */
export function* installInvocationToolRuntimeComposition(
  options: InvocationToolRuntimeDriverOptions & {
    installEphemeralEffects(
      registrations: ToolInvocationEphemeralEffectRegistrations,
    ): Operation<void>;
  },
): Operation<ToolRuntime> {
  // Install first so duplicate-tool validation fails before any
  // ephemeral-effect context is published.
  const runtime = yield* installInvocationToolRuntime(options);
  yield* options.installEphemeralEffects(
    createToolInvocationEphemeralEffectRegistrations({
      tools: new Map(options.tools.map((tool: AnyToolContract) => [tool.name, tool])),
    }),
  );
  return runtime;
}
