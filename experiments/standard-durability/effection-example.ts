import { run } from "effection";
import { effection } from "./effection.ts";
import { createConversation } from "./conversation.ts";

/** Callable example, deliberately not auto-executed on import. */
export function example(log: (event: string) => void) {
  const conversation = createConversation(effection);
  return run(() =>
    conversation.application(
      {
        *sample(prompt) {
          return `primary: ${prompt}`;
        },
        *countTokens(text) {
          return text.length;
        },
      },
      {
        *sample(prompt) {
          return `alternate: ${prompt}`;
        },
        *countTokens(text) {
          return text.length;
        },
      },
      log,
    ),
  );
}
