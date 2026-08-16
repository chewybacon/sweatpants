export interface ProjectionWriter<T, TNote> {
  readonly value: T;
  readonly notes: readonly TNote[];
  map<U>(fn: (value: T) => U): ProjectionWriter<U, TNote>;
  bind<U>(fn: (value: T) => ProjectionWriter<U, TNote>): ProjectionWriter<U, TNote>;
  tell(...notes: readonly TNote[]): ProjectionWriter<T, TNote>;
}

export function writer<T, TNote>(
  value: T,
  notes: readonly TNote[] = [],
): ProjectionWriter<T, TNote> {
  return {
    value,
    notes: [...notes],
    map<U>(fn: (value: T) => U): ProjectionWriter<U, TNote> {
      return writer(fn(value), notes);
    },
    bind<U>(fn: (value: T) => ProjectionWriter<U, TNote>): ProjectionWriter<U, TNote> {
      const next = fn(value);
      return writer(next.value, [...notes, ...next.notes]);
    },
    tell(...additional) {
      return writer(value, [...notes, ...additional]);
    },
  };
}

export type ProjectionResult<T, TError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TError };

export interface ResultWriter<T, TError, TNote> {
  readonly result: ProjectionResult<T, TError>;
  readonly notes: readonly TNote[];
  map<U>(fn: (value: T) => U): ResultWriter<U, TError, TNote>;
  bind<U>(fn: (value: T) => ResultWriter<U, TError, TNote>): ResultWriter<U, TError, TNote>;
  tell(...notes: readonly TNote[]): ResultWriter<T, TError, TNote>;
}

export function resultWriter<T, TError, TNote>(
  result: ProjectionResult<T, TError>,
  notes: readonly TNote[] = [],
): ResultWriter<T, TError, TNote> {
  return {
    result,
    notes: [...notes],
    map<U>(fn: (value: T) => U): ResultWriter<U, TError, TNote> {
      return resultWriter(result.ok ? { ok: true, value: fn(result.value) } : result, notes);
    },
    bind<U>(fn: (value: T) => ResultWriter<U, TError, TNote>): ResultWriter<U, TError, TNote> {
      if (!result.ok) return resultWriter(result, notes);
      const next = fn(result.value);
      return resultWriter(next.result, [...notes, ...next.notes]);
    },
    tell(...additional) {
      return resultWriter(result, [...notes, ...additional]);
    },
  };
}

export interface ProjectionContext {
  readonly basis: string;
}

export type ContextStage<I, O, TNote> = (
  input: I,
  context: ProjectionContext,
) => ProjectionWriter<O, TNote>;

export function applyStage<I, O, TNote>(
  current: ProjectionWriter<I, TNote>,
  context: ProjectionContext,
  stage: ContextStage<I, O, TNote>,
): ProjectionWriter<O, TNote> {
  return current.bind((value) => stage(value, context));
}

export interface IteratedProjectionStage<TInput, TOutput, TError, TNote, TContext> {
  readonly name: string;
  project(input: TInput, context: TContext): ResultWriter<TOutput, TError, TNote>;
}

export type ProjectionIteration<TError, TNote> =
  | {
      readonly stage: string;
      readonly index: number;
      readonly outcome: "accepted";
      readonly notes: readonly TNote[];
    }
  | {
      readonly stage: string;
      readonly index: number;
      readonly outcome: "rejected";
      readonly error: TError;
      readonly notes: readonly TNote[];
    };

type ErasedProjectionStage<TError, TNote, TContext> = IteratedProjectionStage<
  unknown,
  unknown,
  TError,
  TNote,
  TContext
>;

export interface ProjectionExecutable<TInput, TOutput, TError, TNote, TContext> {
  iterate(
    input: TInput,
    context: TContext,
  ): Generator<ProjectionIteration<TError, TNote>, ResultWriter<TOutput, TError, TNote>, void>;
}

export interface ProjectionPipeline<
  TInput,
  TOutput,
  TError,
  TNote,
  TContext,
> extends ProjectionExecutable<TInput, TOutput, TError, TNote, TContext> {
  readonly stages: readonly string[];
  through<TNext>(
    name: string,
    project: (input: TOutput, context: TContext) => ResultWriter<TNext, TError, TNote>,
  ): ProjectionPipeline<TInput, TNext, TError, TNote, TContext>;
}

/**
 * Builds an immutable, lazy projection program. `.through()` checks every
 * adjacent stage type; execution erases only those intermediate types so one
 * heterogeneous stage list can be iterated at runtime.
 */
export function projectionPipeline<TInput, TError, TNote, TContext>(): ProjectionPipeline<
  TInput,
  TInput,
  TError,
  TNote,
  TContext
> {
  return createProjectionPipeline<TInput, TInput, TError, TNote, TContext>([]);
}

export type ProjectionObserver<TError, TNote> = (
  iteration: ProjectionIteration<TError, TNote>,
) => void;

/** Drain a pipeline iterator and preserve its terminal generator value. */
export function runProjection<TInput, TOutput, TError, TNote, TContext>(
  pipeline: ProjectionExecutable<TInput, TOutput, TError, TNote, TContext>,
  input: TInput,
  context: TContext,
  observe?: ProjectionObserver<TError, TNote>,
): ResultWriter<TOutput, TError, TNote> {
  const iterator = pipeline.iterate(input, context);
  let next = iterator.next();
  while (!next.done) {
    observe?.(next.value);
    next = iterator.next();
  }
  return next.value;
}

/** Test/inspection helper that retains every yielded stage observation. */
export function collectProjection<TInput, TOutput, TError, TNote, TContext>(
  pipeline: ProjectionExecutable<TInput, TOutput, TError, TNote, TContext>,
  input: TInput,
  context: TContext,
): {
  readonly iterations: readonly ProjectionIteration<TError, TNote>[];
  readonly final: ResultWriter<TOutput, TError, TNote>;
} {
  const iterations: ProjectionIteration<TError, TNote>[] = [];
  const final = runProjection(pipeline, input, context, (iteration) => {
    iterations.push(iteration);
  });
  return { iterations: Object.freeze(iterations), final };
}

export type GeneratorProjectionStage<TInput, TOutput, TNote, TContext> = (
  input: TInput,
  context: TContext,
) => Generator<TNote, TOutput, void>;

interface ErasedGeneratorProjectionStage<TNote, TContext> {
  readonly name: string;
  project(input: unknown, context: TContext): Generator<TNote, unknown, void>;
}

export interface GeneratorProjectionPipeline<
  TInput,
  TOutput,
  TError,
  TNote,
  TContext,
> extends ProjectionExecutable<TInput, TOutput, TError, TNote, TContext> {
  readonly stages: readonly string[];
  through<TNext>(
    name: string,
    project: GeneratorProjectionStage<TOutput, TNext, TNote, TContext>,
  ): GeneratorProjectionPipeline<TInput, TNext, TError, TNote, TContext>;
  map<TNext>(
    name: string,
    project: (input: TOutput, context: TContext) => TNext,
  ): GeneratorProjectionPipeline<TInput, TNext, TError, TNote, TContext>;
}

/**
 * Generator-native variant: stages yield Writer notes, return their next value,
 * and throw domain errors. The interpreter owns accumulation and converts a
 * thrown value once through `mapError`.
 */
export function generatorProjectionPipeline<TInput, TError, TNote, TContext>(
  mapError: (error: unknown) => TError,
): GeneratorProjectionPipeline<TInput, TInput, TError, TNote, TContext> {
  return createGeneratorProjectionPipeline<TInput, TInput, TError, TNote, TContext>([], mapError);
}

function createGeneratorProjectionPipeline<TInput, TOutput, TError, TNote, TContext>(
  stages: readonly ErasedGeneratorProjectionStage<TNote, TContext>[],
  mapError: (error: unknown) => TError,
): GeneratorProjectionPipeline<TInput, TOutput, TError, TNote, TContext> {
  const append = <TNext>(
    name: string,
    project: GeneratorProjectionStage<TOutput, TNext, TNote, TContext>,
  ): GeneratorProjectionPipeline<TInput, TNext, TError, TNote, TContext> => {
    const typed = { name, project };
    // SAFETY: as with the ResultWriter pipeline, `through()` checks adjacent
    // types before this heterogeneous stage is inserted into the runtime list.
    const erased = typed as unknown as ErasedGeneratorProjectionStage<TNote, TContext>;
    return createGeneratorProjectionPipeline<TInput, TNext, TError, TNote, TContext>(
      [...stages, erased],
      mapError,
    );
  };

  return Object.freeze({
    stages: Object.freeze(stages.map((stage) => stage.name)),
    through<TNext>(
      name: string,
      project: GeneratorProjectionStage<TOutput, TNext, TNote, TContext>,
    ) {
      return append(name, project);
    },
    map<TNext>(name: string, project: (input: TOutput, context: TContext) => TNext) {
      return append(name, function* (input, context) {
        return project(input, context);
      });
    },
    *iterate(
      input: TInput,
      context: TContext,
    ): Generator<ProjectionIteration<TError, TNote>, ResultWriter<TOutput, TError, TNote>, void> {
      let value: unknown = input;
      const accumulated: TNote[] = [];
      for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index]!;
        const stageNotes: TNote[] = [];
        try {
          const iterator = stage.project(value, context);
          let next = iterator.next();
          while (!next.done) {
            stageNotes.push(next.value);
            next = iterator.next();
          }
          value = next.value;
          accumulated.push(...stageNotes);
          yield Object.freeze({
            stage: stage.name,
            index,
            outcome: "accepted" as const,
            notes: Object.freeze([...stageNotes]),
          });
        } catch (error) {
          const mapped = mapError(error);
          accumulated.push(...stageNotes);
          yield Object.freeze({
            stage: stage.name,
            index,
            outcome: "rejected" as const,
            error: mapped,
            notes: Object.freeze([...stageNotes]),
          });
          return resultWriter<TOutput, TError, TNote>({ ok: false, error: mapped }, accumulated);
        }
      }
      return resultWriter<TOutput, TError, TNote>(
        { ok: true, value: value as TOutput },
        accumulated,
      );
    },
  });
}

function createProjectionPipeline<TInput, TOutput, TError, TNote, TContext>(
  stages: readonly ErasedProjectionStage<TError, TNote, TContext>[],
): ProjectionPipeline<TInput, TOutput, TError, TNote, TContext> {
  return Object.freeze({
    stages: Object.freeze(stages.map((stage) => stage.name)),
    through<TNext>(
      name: string,
      project: (input: TOutput, context: TContext) => ResultWriter<TNext, TError, TNote>,
    ): ProjectionPipeline<TInput, TNext, TError, TNote, TContext> {
      const typed: IteratedProjectionStage<TOutput, TNext, TError, TNote, TContext> = {
        name,
        project,
      };
      // SAFETY: `through()` accepts only the current pipeline output as its
      // input. Intermediate types are existential after insertion and restored
      // by the next typed builder call; the runtime visits the list in order.
      const erased = typed as unknown as ErasedProjectionStage<TError, TNote, TContext>;
      return createProjectionPipeline<TInput, TNext, TError, TNote, TContext>([...stages, erased]);
    },
    *iterate(
      input: TInput,
      context: TContext,
    ): Generator<ProjectionIteration<TError, TNote>, ResultWriter<TOutput, TError, TNote>, void> {
      let current: ResultWriter<unknown, TError, TNote> = resultWriter({
        ok: true,
        value: input,
      });
      for (let index = 0; index < stages.length; index += 1) {
        if (!current.result.ok) break;
        const stage = stages[index]!;
        const next = stage.project(current.result.value, context);
        current = resultWriter(next.result, [...current.notes, ...next.notes]);
        const notes = Object.freeze([...next.notes]);
        if (next.result.ok) {
          yield Object.freeze({
            stage: stage.name,
            index,
            outcome: "accepted" as const,
            notes,
          });
        } else {
          yield Object.freeze({
            stage: stage.name,
            index,
            outcome: "rejected" as const,
            error: next.result.error,
            notes,
          });
          break;
        }
      }
      return current as ResultWriter<TOutput, TError, TNote>;
    },
  });
}
