import { createChatHandler } from "@sweatpants/agent-host/server";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { env } from "@/env";
import { setupYoChatModelProvider } from "./model-provider";
import { createYoChatProgramDriverJournalStore } from "./program-driver-journal";
import type { ProgramDriverJournalStore } from "@sweatpants/durable-chat-runtime/durable-handler";

/** Expected composition failure for invalid ProgramRuntime configuration. */
export class ProgramDriverConfigurationError extends Error {
  readonly _tag = "ProgramDriverConfigurationError";
  readonly code = "PROGRAM_DRIVER_SECRET_REQUIRED";

  constructor() {
    super("PROGRAM_DRIVER_CAPABILITY_SECRET is required for durable chat execution");
    this.name = "ProgramDriverConfigurationError";
  }
}

let activeProgramDriverJournalStore: ProgramDriverJournalStore | undefined;

/** Returns the journal store owned by the active yo-chat handler for dev inspection. */
export function getActiveProgramDriverJournalStore(): ProgramDriverJournalStore | undefined {
  return activeProgramDriverJournalStore;
}

/** Creates the configured yo-chat handler without acquiring application resources. */
export function createYoChatHandler(): ReturnType<typeof createChatHandler> {
  const secret = env.PROGRAM_DRIVER_CAPABILITY_SECRET;
  if (!secret) {
    throw new ProgramDriverConfigurationError();
  }
  const keyring = createCapabilityKeyring("yo-chat-program-driver", [
    { keyId: "yo-chat-program-driver-v1", secret },
  ]);
  const journalStore = createYoChatProgramDriverJournalStore(keyring);
  activeProgramDriverJournalStore = journalStore;
  return createChatHandler({
    setup: setupYoChatModelProvider,
    maxToolIterations: 10,
    programDriverJournalStore: journalStore,
  });
}
