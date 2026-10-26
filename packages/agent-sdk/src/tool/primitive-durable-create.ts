import type { z } from "zod";
import type { Operation } from "@sweatpants/standard-durability";
import { defineJournalTool, type JournalRequest, type JournalToolContext } from "../primitive.ts";

type Effects = Parameters<typeof defineJournalTool>[0]["effects"];
type Elicits = Parameters<typeof defineJournalTool>[0]["elicits"];

type Context<E extends Effects, L extends Elicits, Sampling extends boolean> = Omit<
  JournalToolContext<E, L>,
  "sample" | "elicit" | "effect"
> &
  (Sampling extends true ? Pick<JournalToolContext<E, L>, "sample"> : {}) &
  (keyof L extends never ? {} : Pick<JournalToolContext<E, L>, "elicit">) &
  (keyof E extends never ? {} : Pick<JournalToolContext<E, L>, "effect">);

interface Definition<
  P extends z.ZodType,
  O extends z.ZodType | undefined,
  E extends Effects,
  L extends Elicits,
> {
  name: string;
  version: string;
  description: string;
  parameters: P;
  output: O;
  effects: E;
  elicits: L;
  sampling: boolean;
}

/** Fluent authoring over the existing primitive compiler and journal request contract. */
class DurableToolBuilder<
  P extends z.ZodType,
  O extends z.ZodType | undefined = undefined,
  E extends Effects = {},
  L extends Elicits = {},
  Sampling extends boolean = false,
> {
  constructor(private readonly definition: Definition<P, O, E, L>) {}

  output<Next extends z.ZodType>(schema: Next) {
    return new DurableToolBuilder<P, Next, E, L, Sampling>({ ...this.definition, output: schema });
  }

  effects<Next extends Effects>(effects: Next) {
    return new DurableToolBuilder<P, O, E & Next, L, Sampling>({
      ...this.definition,
      effects: { ...this.definition.effects, ...effects },
    });
  }

  elicits<Next extends Elicits>(elicits: Next) {
    return new DurableToolBuilder<P, O, E, Next, Sampling>({ ...this.definition, elicits });
  }

  samples() {
    return new DurableToolBuilder<P, O, E, L, true>({ ...this.definition, sampling: true });
  }

  execute<Result extends O extends z.ZodType ? z.output<O> : unknown>(
    body: (input: z.output<P>, ctx: Context<E, L, Sampling>) => Operation<Result, JournalRequest>,
  ) {
    return defineJournalTool({ ...this.definition, execute: body });
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
        parameters<P extends z.ZodType>(schema: P) {
          return new DurableToolBuilder<P>({
            name,
            version,
            description,
            parameters: schema,
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
