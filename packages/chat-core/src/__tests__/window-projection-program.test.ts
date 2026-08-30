import {
  collectProjectionProgram,
  note,
  runProjectionProgram,
  stage,
  type ProjectionProgram,
} from "@sweatpants/foundation/projection";
import { describe, expect, it } from "vitest";
import {
  decodePublicProjectionRoot,
  type PublicProjectionRoot,
} from "../client/conversation-window.ts";
import {
  materializeChatMessages,
  projectChatMessagesToAGUI,
} from "../client/chat-client-projection.ts";
import { projectionFromPublicRoots, PublicRootConflictError } from "../client/window-projection.ts";

type ProjectionNote = { readonly kind: string; readonly count: number };

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * The whole provider projection, written as one program. Each `yield*` returns
 * the exact type of the delegated step, so no stage list, builder, or cast is
 * involved; the runner supplies notes, stage paths, and error conversion.
 */
function* providerProjection(
  roots: readonly PublicProjectionRoot[],
): ProjectionProgram<ReturnType<typeof projectChatMessagesToAGUI>, ProjectionNote> {
  const state = yield* stage("roots", function* () {
    yield* note({ kind: "root-input", count: roots.length });
    return projectionFromPublicRoots(roots);
  });

  const messages = yield* stage("messages", function* () {
    const materialized = materializeChatMessages(state, { allowPending: true });
    yield* note({ kind: "messages-produced", count: materialized.length });
    return materialized;
  });

  return yield* stage("provider", function* () {
    const history = projectChatMessagesToAGUI(messages);
    yield* note({ kind: "provider-produced", count: history.length });
    return history;
  });
}

function directProviderProjection(roots: readonly PublicProjectionRoot[]) {
  const state = projectionFromPublicRoots(roots);
  const messages = materializeChatMessages(state, { allowPending: true });
  return projectChatMessagesToAGUI(messages);
}

function messageRoot(id: string, position: string, text: string): PublicProjectionRoot {
  return decodePublicProjectionRoot({
    rootId: `message:${id}`,
    position,
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id, role: "user", content: text },
    placement: { type: "root", sequence: Number(position) },
  });
}

describe("real window projection program experiment", () => {
  it("matches direct projection and records evidence per real stage", () => {
    const roots = [messageRoot("user-1", "0", "one"), messageRoot("user-2", "1", "two")];

    const outcome = runProjectionProgram(() => providerProjection(roots), toError);

    expect(outcome).toMatchObject({
      ok: true,
      value: directProviderProjection(roots),
    });
    expect(outcome.notes).toEqual([
      { kind: "root-input", count: 2 },
      { kind: "messages-produced", count: 2 },
      { kind: "provider-produced", count: 2 },
    ]);
  });

  it("stops at a real public-root conflict and reports its stage path", () => {
    const roots = [messageRoot("user-1", "0", "original"), messageRoot("user-1", "0", "conflict")];

    const execution = collectProjectionProgram(() => providerProjection(roots), toError);

    expect(execution.outcome.ok).toBe(false);
    if (!execution.outcome.ok) {
      expect(execution.outcome.error).toBeInstanceOf(PublicRootConflictError);
      expect(execution.outcome.error).toMatchObject({ code: "public_root_conflict" });
      expect(execution.outcome.path).toEqual(["roots"]);
    }
    expect(execution.outcome.notes).toEqual([{ kind: "root-input", count: 2 }]);
    expect(
      execution.events.filter((event) => event.type === "enter").map((event) => event.path),
    ).toEqual([["roots"]]);
  });

  it("supports a conditional stage inside the same program", () => {
    function* optionalProvider(
      roots: readonly PublicProjectionRoot[],
    ): ProjectionProgram<number, ProjectionNote> {
      const state = yield* stage("roots", function* () {
        return projectionFromPublicRoots(roots);
      });
      const messages = materializeChatMessages(state, { allowPending: true });
      if (messages.length === 0) {
        yield* note({ kind: "skipped-provider", count: 0 });
        return 0;
      }
      const history = yield* stage("provider", function* () {
        return projectChatMessagesToAGUI(messages);
      });
      return history.length;
    }

    const empty = runProjectionProgram(() => optionalProvider([]), toError);
    const populated = runProjectionProgram(
      () => optionalProvider([messageRoot("user-1", "0", "one")]),
      toError,
    );

    expect(empty).toMatchObject({ ok: true, value: 0 });
    expect(empty.notes).toEqual([{ kind: "skipped-provider", count: 0 }]);
    expect(populated).toMatchObject({ ok: true, value: 1 });
  });
});
