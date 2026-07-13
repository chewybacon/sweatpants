import {
  createCapabilityKeyring,
  createChatApplication,
  createChatHandler,
} from "@sweatpants/framework/server";
import { appEnv as env } from "@/env.schema";
import { setupLogger } from "@sweatpants/framework/chat";
import { setupYoChatDurableStreams } from "./durable-streams";
import { setupYoChatModelProvider } from "./model-provider";
import { setupYoChatBaseContexts } from "./tools";
import { setupYoChatPluginsAndRuntime } from "./tool-runtime";
import { createYoChatProgramDriverJournalStore } from "./program-driver-journal";
export { withDefaultSystemPrompt } from "./default-system-prompt";

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

/** Creates yo-chat with one root scope and the parsed execution-engine configuration. */
export function createYoChatApplication() {
  const setup = function* setupApplication() {
    yield* setupLogger();
    yield* setupYoChatDurableStreams();
    yield* setupYoChatBaseContexts();
    yield* setupYoChatPluginsAndRuntime();
  };
  const handler =
    env.SWEATPANTS_EXECUTION_ENGINE === "program-driver"
      ? createChatHandler({
          setup: setupYoChatModelProvider,
          maxToolIterations: 10,
          executionEngine: "program-driver",
          programDriverJournalStore: createYoChatProgramDriverJournalStore(
            createProgramDriverKeyring(),
          ),
        })
      : createChatHandler({
          setup: setupYoChatModelProvider,
          maxToolIterations: 10,
        });

  return createChatApplication({ setup, handler });
}

function createProgramDriverKeyring() {
  const secret = env.PROGRAM_DRIVER_CAPABILITY_SECRET;
  if (!secret) {
    throw new ProgramDriverConfigurationError();
  }
  return createCapabilityKeyring("yo-chat-program-driver", [
    { keyId: "yo-chat-program-driver-v1", secret },
  ]);
}

export const chatApp = createYoChatApplication();
