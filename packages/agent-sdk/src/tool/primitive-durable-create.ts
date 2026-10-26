import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SchemaProjectionOptions } from "./types.ts";
import type { Operation } from "@sweatpants/standard-durability";
import {
  compileJournalTool,
  type Effects,
  type Elicits,
  type JournalRequest,
  type JournalToolContext,
} from "./journal-compiler.ts";

type Context<E extends Effects, L extends Elicits, Sampling extends boolean> = Omit<
  JournalToolContext<E, L>,
  "sample" | "elicit" | "effect"
> &
  (Sampling extends true ? Pick<JournalToolContext<E, L>, "sample"> : {}) &
  (keyof L extends never ? {} : Pick<JournalToolContext<E, L>, "elicit">) &
  (keyof E extends never ? {} : Pick<JournalToolContext<E, L>, "effect">);

interface Definition<
  P extends StandardSchemaV1,
  O extends StandardSchemaV1 | undefined,
  E extends Effects,
  L extends Elicits,
> {
  name: string;
  version: string;
  description: string;
  parameters: P;
  output: O;
  parametersProjections?: SchemaProjectionOptions;
  outputProjections?: SchemaProjectionOptions;
  effects: E;
  elicits: L;
  sampling: boolean;
}

/** Fluent authoring over the existing primitive compiler and journal request contract. */
class DurableToolBuilder<
  P extends StandardSchemaV1,
  O extends StandardSchemaV1 | undefined = undefined,
  E extends Effects = {},
  L extends Elicits = {},
  Sampling extends boolean = false,
> {
  constructor(private readonly definition: Definition<P, O, E, L>) {}

  output<Next extends StandardSchemaV1>(schema: Next, projections?: SchemaProjectionOptions) {
    return new DurableToolBuilder<P, Next, E, L, Sampling>({
      ...this.definition,
      output: schema,
      outputProjections: projections,
    });
  }

  effects<Next extends Effects>(effects: Next) {
    return new DurableToolBuilder<P, O, Omit<E, keyof Next> & Next, L, Sampling>({
      ...this.definition,
      effects: { ...this.definition.effects, ...effects },
    });
  }

  elicits<Next extends Elicits>(elicits: Next) {
    return new DurableToolBuilder<P, O, E, Omit<L, keyof Next> & Next, Sampling>({
      ...this.definition,
      elicits: { ...this.definition.elicits, ...elicits },
    });
  }

  samples() {
    return new DurableToolBuilder<P, O, E, L, true>({ ...this.definition, sampling: true });
  }

  execute<Result extends O extends StandardSchemaV1 ? StandardSchemaV1.InferInput<O> : unknown>(
    body: (
      input: StandardSchemaV1.InferOutput<P>,
      ctx: Context<E, L, Sampling>,
    ) => Operation<Result, JournalRequest>,
  ) {
    return compileJournalTool({ ...this.definition, execute: body });
  }
}

/** Interim primitive entrypoint. It never constructs a crank manifest or ProgramDriver. */
export function createDurableTool(name: string, options: { version: string }) {
  if (!name.trim() || !options.version.trim()) {
    throw new Error("Durable tool name and version must be non-empty");
  }
  const version = options.version;
  return {
    description(description: string) {
      if (!description.trim()) {
        throw new Error("Durable tool description must be non-empty");
      }
      return {
        parameters<P extends StandardSchemaV1>(schema: P, projections?: SchemaProjectionOptions) {
          return new DurableToolBuilder<P>({
            name,
            version,
            description,
            parameters: schema,
            parametersProjections: projections,
            output: undefined,
            effects: {},
            elicits: {},
            sampling: false,
          });
        },
      };
    },
  };
}
