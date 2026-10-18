/**
 * Projection programs: one generator, delegated with `yield*`.
 *
 * The previous pipeline style stored an array of heterogeneous stages, which
 * forced a builder and one existential cast to keep intermediate types. A
 * generator program needs neither: `yield*` delegation already threads the
 * value type from stage to stage, so TypeScript infers the whole chain and the
 * runtime keeps no stage list at all.
 *
 * The program yields instructions; the runner interprets them.
 */

/** One instruction a projection program can yield. */
export type ProjectionEffect<TNote> =
  | { readonly type: "note"; readonly note: TNote }
  | { readonly type: "enter"; readonly stage: string }
  | { readonly type: "exit"; readonly stage: string };

/** A pure projection program producing `TValue` and yielding `TNote` evidence. */
export type ProjectionProgram<TValue, TNote> = Generator<ProjectionEffect<TNote>, TValue, void>;

/** Record evidence without changing the projected value. */
export function* note<TNote>(value: TNote): ProjectionProgram<void, TNote> {
  yield { type: "note", note: value };
}

/**
 * Name a region of a program. Stages nest, so a projection can be composed from
 * smaller projections without the runner knowing their shape in advance.
 */
export function* stage<TValue, TNote>(
  name: string,
  body: () => ProjectionProgram<TValue, TNote>,
): ProjectionProgram<TValue, TNote> {
  yield { type: "enter", stage: name };
  const value = yield* body();
  yield { type: "exit", stage: name };
  return value;
}

export type ProjectionEvent<TNote> =
  | {
      readonly type: "note";
      readonly path: readonly string[];
      readonly note: TNote;
    }
  | { readonly type: "enter"; readonly path: readonly string[] }
  | { readonly type: "exit"; readonly path: readonly string[] };

export type ProjectionOutcome<TValue, TError, TNote> = {
  readonly notes: readonly TNote[];
} & (
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError; readonly path: readonly string[] }
);

/**
 * Interpret a projection program.
 *
 * The runner owns note accumulation, stage paths, observation, and the single
 * conversion of a thrown domain error. Programs stay ordinary generators.
 *
 * Short-circuiting is host-level rather than algebraic: a stage throws its own
 * domain error instead of yielding a failure effect. A throw therefore skips
 * the remaining `exit` effects, which is deliberate — the retained stage stack
 * is what reports `path`. Observers consequently see unbalanced `enter`/`exit`
 * on failure and must not assume they are paired.
 *
 * `program` is a thunk because a generator object is one-shot; the monad is on
 * `() => ProjectionProgram`, not on the generator itself.
 */
export function runProjectionProgram<TValue, TError, TNote>(
  program: () => ProjectionProgram<TValue, TNote>,
  mapError: (error: unknown, path: readonly string[]) => TError,
  observe?: (event: ProjectionEvent<TNote>) => void,
): ProjectionOutcome<TValue, TError, TNote> {
  const notes: TNote[] = [];
  const path: string[] = [];
  const iterator = program();

  try {
    let next = iterator.next();
    while (!next.done) {
      const effect = next.value;
      if (effect.type === "note") {
        notes.push(effect.note);
        observe?.({ type: "note", path: [...path], note: effect.note });
      } else if (effect.type === "enter") {
        path.push(effect.stage);
        observe?.({ type: "enter", path: [...path] });
      } else {
        observe?.({ type: "exit", path: [...path] });
        path.pop();
      }
      next = iterator.next();
    }
    return { ok: true, value: next.value, notes: Object.freeze(notes) };
  } catch (error) {
    return {
      ok: false,
      error: mapError(error, [...path]),
      path: Object.freeze([...path]),
      notes: Object.freeze(notes),
    };
  }
}

/** Run a program and keep every observed event, for tests and diagnostics. */
export function collectProjectionProgram<TValue, TError, TNote>(
  program: () => ProjectionProgram<TValue, TNote>,
  mapError: (error: unknown, path: readonly string[]) => TError,
): {
  readonly events: readonly ProjectionEvent<TNote>[];
  readonly outcome: ProjectionOutcome<TValue, TError, TNote>;
} {
  const events: ProjectionEvent<TNote>[] = [];
  const outcome = runProjectionProgram(program, mapError, (event) => {
    events.push(event);
  });
  return { events: Object.freeze(events), outcome };
}
