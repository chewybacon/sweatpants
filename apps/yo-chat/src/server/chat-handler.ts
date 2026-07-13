import {
  createCapabilityKeyring,
  createChatHandler,
  type ChatHandlerConfig,
} from "@sweatpants/framework/server";
import { env } from "@/env";
import { setupYoChatModelProvider } from "./model-provider";
import { createYoChatProgramDriverJournalStore } from "./program-driver-journal";

/** Expected composition failure for invalid ProgramRuntime configuration. */
export class ProgramDriverConfigurationError extends Error {
  readonly _tag = "ProgramDriverConfigurationError";
  readonly code = "PROGRAM_DRIVER_SECRET_REQUIRED";

  constructor() {
    super(
      "PROGRAM_DRIVER_CAPABILITY_SECRET is required when SWEATPANTS_EXECUTION_ENGINE=program-driver",
    );
    this.name = "ProgramDriverConfigurationError";
  }
}

/** Creates the configured yo-chat handler without acquiring application resources. */
export function createYoChatHandler(): ReturnType<typeof createChatHandler> {
  const shared: Pick<ChatHandlerConfig, "setup" | "maxToolIterations"> = {
    setup: setupYoChatModelProvider,
    maxToolIterations: 10,
  };
  if (env.SWEATPANTS_EXECUTION_ENGINE !== "program-driver") {
    return createChatHandler(shared);
  }
  const secret = env.PROGRAM_DRIVER_CAPABILITY_SECRET;
  if (!secret) {
    throw new ProgramDriverConfigurationError();
  }
  const keyring = createCapabilityKeyring("yo-chat-program-driver", [
    { keyId: "yo-chat-program-driver-v1", secret },
  ]);
  return createChatHandler({
    ...shared,
    executionEngine: "program-driver",
    programDriverJournalStore: createYoChatProgramDriverJournalStore(keyring),
  });
}
