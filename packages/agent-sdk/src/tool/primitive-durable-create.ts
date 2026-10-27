import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SchemaProjectionOptions } from "./types.ts";
import type { Operation } from "@sweatpants/standard-durability";
import {
  compileJournalTool,
  type Effects,
  type Elicits,
  type JournalToolContext,
} from "./journal-compiler.ts";

type Context<E extends Effects, L extends Elicits, Sampling extends boolean, Y> = Omit<
  JournalToolContext<E, L, Y>,
  "sample" | "elicit" | "effect"
> &
  (Sampling extends true ? Pick<JournalToolContext<E, L, Y>, "sample"> : {}) &
  (keyof L extends never ? {} : Pick<JournalToolContext<E, L, Y>, "elicit">) &
  (keyof E extends never ? {} : Pick<JournalToolContext<E, L, Y>, "effect">);

interface Definition<
  N extends string,
  P extends StandardSchemaV1,
  O extends StandardSchemaV1 | undefined,
  E extends Effects,
  L extends Elicits,
> {
  name: N;
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
  N extends string,
  P extends StandardSchemaV1,
  O extends StandardSchemaV1 | undefined = undefined,
  E extends Effects = {},
  L extends Elicits = {},
  Sampling extends boolean = false,
> {
  constructor(private readonly definition: Definition<N, P, O, E, L>) {}

  output<Next extends StandardSchemaV1>(schema: Next, projections?: SchemaProjectionOptions) {
    return new DurableToolBuilder<N, P, Next, E, L, Sampling>({
      ...this.definition,
      output: schema,
      outputProjections: projections,
    });
  }

  effects<Next extends Effects>(effects: Next) {
    return new DurableToolBuilder<N, P, O, Omit<E, keyof Next> & Next, L, Sampling>({
      ...this.definition,
      effects: { ...this.definition.effects, ...effects },
    });
  }

  elicits<Next extends Elicits>(elicits: Next) {
    return new DurableToolBuilder<N, P, O, E, Omit<L, keyof Next> & Next, Sampling>({
      ...this.definition,
      elicits: { ...this.definition.elicits, ...elicits },
    });
  }

  samples() {
    return new DurableToolBuilder<N, P, O, E, L, true>({ ...this.definition, sampling: true });
  }

  execute<Result extends O extends StandardSchemaV1 ? StandardSchemaV1.InferInput<O> : unknown>(
    body: <Y>(
      input: StandardSchemaV1.InferOutput<P>,
      ctx: Context<E, L, Sampling, Y>,
    ) => Operation<Result, Y>,
  ): ReturnType<typeof compileJournalTool<P, O, E, L, N, Result>> {
    return compileJournalTool({ ...this.definition, execute: body });
  }
}

/** Portable journal tool authoring; native capabilities are supplied by the host. */
export function createDurableTool<const N extends string>(name: N, options: { version: string }) {
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
          return new DurableToolBuilder<N, P>({
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
