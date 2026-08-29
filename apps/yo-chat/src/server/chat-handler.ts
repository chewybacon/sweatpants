import { createChatEndpoints, type ChatAppConfig } from "@sweatpants/agent-host/server";
import { env } from "@/env";
import { setupYoChatModelProvider } from "./model-provider";
import { createYoChatStorageConfig } from "./storage-config";
import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";

/** Expected composition failure for invalid workflow host configuration. */
export class ProgramDriverConfigurationError extends Error {
  readonly _tag = "ProgramDriverConfigurationError";
  readonly code = "PROGRAM_DRIVER_SECRET_REQUIRED";

  constructor() {
    super("PROGRAM_DRIVER_CAPABILITY_SECRET is required for durable chat execution");
    this.name = "ProgramDriverConfigurationError";
  }
}

/**
 * The yo-chat durable chat configuration. One name + secret derives journal
 * and projection-token keys; `programs` registers durable tool schemas.
 */
export function yoChatConfig(): ChatAppConfig {
  const secret = env.PROGRAM_DRIVER_CAPABILITY_SECRET;
  if (!secret) {
    throw new ProgramDriverConfigurationError();
  }
  return {
    name: "yo-chat",
    secret,
    storage: createYoChatStorageConfig(),
    programs: [pickCard, playTttTool],
    setup: setupYoChatModelProvider,
    maxToolIterations: 10,
  };
}

/** Creates route-independent yo-chat endpoint capabilities. */
export function createYoChatEndpoints(): ReturnType<typeof createChatEndpoints> {
  return createChatEndpoints(yoChatConfig());
}
