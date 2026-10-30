import { canonicalDigest } from "@sweatpants/foundation";
import { effection } from "@sweatpants/standard-durability-effection";
import { SqliteJournal } from "../../packages/primitive-journal/src/sqlite.ts";
import {
  createPiAiModelProvider,
  type ModelSelection,
} from "../../packages/model-provider-pi-ai/src/index.ts";
import { ModelDefinition } from "./model-api.ts";
import { createEffectionModelOperations } from "./provider-chat.ts";
import { createScopedChat } from "./chat.ts";

export interface ChatAppOptions {
  database: string;
  /** Reuse only when resuming this exact turn; use a new ID for a new message. */
  turnId: string;
  text: string;
  model: ModelSelection;
  write(text: string): void;
}

/** A single-turn application composition, callable from an Effection scope. */
export function chatApp(options: ChatAppOptions) {
  return effection.scoped(function* () {
    // The application chooses and installs an implementation of the declared Model API.
    const provider = createPiAiModelProvider();
    const chat = createScopedChat(effection);
    yield* chat.Model.host.install(createEffectionModelOperations(chat, provider.driver));
    const model = provider.resolveModel(options.model);
    const configuration = { selection: options.model, temperature: 0.2 };
    const input = {
      messageId: options.turnId,
      text: options.text,
      modelIdentity: canonicalDigest(configuration),
      messages: [{ role: "user", content: [{ type: "text", text: options.text }] }],
    };
    const journal = new SqliteJournal(options.database, {
      executionId: options.turnId,
      program: {
        id: "typed-chat-example",
        version: "1",
        digest: canonicalDigest({
          api: ModelDefinition.id,
          sample: ModelDefinition.operations.sample.version,
          application: "1",
        }),
      },
      input,
    });
    yield* effection.ensure(function* () {
      journal.close();
    });

    // Provisional output is a scoped capability, so normal middleware can consume it.
    yield* chat.Output.around({
      *publish([event], next) {
        if (event.type === "text-delta") {
          options.write(event.delta);
        }
        yield* next(event);
      },
    });

    // Activation sets ModelConfig for each owned sample.
    // Journal acceptance and replay use the same computation as the earlier examples.
    return yield* chat.activate(
      {
        model: { model, streamOptions: { temperature: configuration.temperature } },
        tools: [],
        effects: {},
      },
      input,
      journal,
    );
  });
}
