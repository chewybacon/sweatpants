import type { AuthorityCommand } from "./authority-contract.ts";

/** Structural addressing fixed by typed command envelopes; capability-only
 * settlements deliberately return undefined for shell-specific verification. */
export function structuralCommandSessionId(command: AuthorityCommand): string | undefined {
  if ("sessionId" in command.request && typeof command.request.sessionId === "string") {
    return command.request.sessionId;
  }
  switch (command.type) {
    case "execution.bind-mandate":
      return command.request.address.sessionId;
    case "execution.release-mandate":
    case "execution.mandate-reserve":
    case "execution.mandate-emission":
    case "execution.mandate-complete":
      return command.request.mandate.address.sessionId;
    default:
      return undefined;
  }
}
