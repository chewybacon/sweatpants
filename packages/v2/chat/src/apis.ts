import type { Api, Composition } from "@standard-durability/core";
import type { ChatContext } from "./contracts.ts";
import { prepareChatInference } from "./inference.ts";

/** Create a scoped preparation API with the pure assembler as its default driver.
 * install replaces preparation; around composes strategies in the caller's scope.
 * Each call is ordinary runtime work, with no journal, cache or provider dispatch. */
export function createChatContext<Y>(
  composition: Composition<Y>,
  name: string,
): Api<ChatContext<Y>, Y> {
  return composition.createApi<ChatContext<Y>>(name, {
    *prepare(input) {
      return prepareChatInference(input);
    },
  });
}
