import type { ChatAppConfig } from "@sweatpants/agent-host/server";
import { createLocalToolInvocationResourceFactory } from "@sweatpants/tool-runtime-local";

/** The same execution adapter contract consumed by createChatApp and local(). */
type ToolExecutionAdapter = NonNullable<ChatAppConfig["execution"]>;

/** Run authored ordinary tools through the real invocation engine, in-process. */
export function testToolRuntime(): ToolExecutionAdapter {
  return {
    prepare(tools) {
      if (tools.some((tool) => tool.execution === "crank_native")) {
        throw new Error(
          "testToolRuntime supports ordinary authored tools; durable placement must be configured explicitly",
        );
      }
      return {
        runtimeId: "test-in-process",
        createResources: () => createLocalToolInvocationResourceFactory({}),
      };
    },
  };
}
