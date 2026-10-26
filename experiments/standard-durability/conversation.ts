import type { Composition, Operation, Operations } from "./contracts.ts";

/** Pure signatures: no Effect/Effection types and no service container. */
export interface Model {
  sample(prompt: string): string;
  countTokens(text: string): number;
}

export interface ConversationContext {
  readonly tenant: string;
}

/** Assemble declarations once. Installing them happens later, inside execution. */
export function createConversation<Y>(composition: Composition<Y>) {
  const Model = composition.createApi<Model>("example:model", {
    *sample() {
      throw new Error("Model not installed");
    },
    *countTokens() {
      throw new Error("Model not installed");
    },
  });
  const Conversation = composition.createContext<ConversationContext>("example:conversation");

  function* answer(prompt: string): Operation<string, Y> {
    const context = yield* Conversation.expect();
    return yield* Model.operations.sample(`${context.tenant}: ${prompt}`);
  }

  /** The same authored computation can be assembled with either adapter. */
  function* application(
    primary: Operations<Model, Y>,
    alternate: Operations<Model, Y>,
    log: (event: string) => void,
  ): Operation<readonly string[], Y> {
    return yield* composition.scoped(function* () {
      yield* Conversation.set({ tenant: "acme" });
      yield* Model.install(primary);
      yield* composition.ensure(function* () {
        log("application:closed");
      });
      yield* Model.around({
        *sample(args, next) {
          log("sample:before");
          try {
            return yield* next(...args);
          } finally {
            log("sample:after");
          }
        },
      });

      const first = yield* answer("Hello");
      // Creating an operation does not capture the primary binding.
      const deferred = answer("Hello from the child");
      const second = yield* composition.scoped(function* () {
        yield* Conversation.set({ tenant: "preview" });
        yield* Model.install(alternate);
        yield* composition.ensure(function* () {
          log("child:closed");
        });
        return yield* deferred;
      });
      // Parent bindings still apply; the child and its cleanup have finished.
      const third = yield* answer("Hello again");
      return [first, second, third];
    });
  }
  return { Model, Conversation, answer, application };
}
