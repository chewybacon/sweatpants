import { describe, expect, it } from "vitest";
import { collectProjectionProgram } from "@sweatpants/foundation/projection";
import type { PublicMessageRoot, PublicProjectionRoot } from "@sweatpants/chat-core";
import { liveProjection } from "./live-compactor.ts";

function root(id: string, position: string): PublicMessageRoot {
  return {
    rootId: `root:${id}`,
    position,
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id, role: "user", content: id },
    placement: { type: "root", sequence: Number(position) },
  };
}

function rootMap(...roots: readonly PublicProjectionRoot[]): Map<string, PublicProjectionRoot> {
  return new Map(roots.map((entry) => [entry.rootId, entry]));
}

describe("client live projection composes the runtime program", () => {
  it("nests the runtime stage paths beneath the client stage", () => {
    const execution = collectProjectionProgram(
      () =>
        liveProjection({
          sealed: rootMap(root("a", "0")),
          hot: rootMap(root("b", "1")),
          liveEvents: [],
          requireComplete: false,
        }),
      (error) => error,
    );

    expect(execution.outcome.ok).toBe(true);
    expect(
      execution.events
        .filter((event) => event.type === "enter")
        .map((event) => event.path.join("/")),
    ).toEqual([
      "merge-roots",
      "project-roots",
      // Stages owned by chat-core, nested under the client's stage.
      "project-roots/index-roots",
      "project-roots/order-anchors",
      "project-roots/seed-messages",
      "project-roots/attach-anchors",
      "project-roots/apply-activities",
      "replay-live",
    ]);
  });

  it("accumulates client and runtime notes in one evidence stream", () => {
    const execution = collectProjectionProgram(
      () =>
        liveProjection({
          sealed: rootMap(root("a", "0")),
          hot: rootMap(root("b", "1")),
          liveEvents: [],
          requireComplete: false,
        }),
      (error) => error,
    );

    expect(execution.outcome.notes).toEqual([
      { kind: "roots-merged", sealed: 1, hot: 1, merged: 2 },
      { kind: "roots-indexed", roots: 2, anchors: 0 },
      { kind: "messages-seeded", messages: 2 },
      { kind: "anchors-attached", anchors: 0 },
      { kind: "activities-applied", nodes: 0 },
      { kind: "live-events-replayed", events: 0 },
    ]);
  });

  it("reports the nested runtime stage that rejected a position conflict", () => {
    const execution = collectProjectionProgram(
      () =>
        liveProjection({
          sealed: rootMap(root("a", "0")),
          hot: rootMap(root("b", "0")),
          liveEvents: [],
          requireComplete: false,
        }),
      (error) => error,
    );

    expect(execution.outcome.ok).toBe(false);
    if (!execution.outcome.ok) {
      expect(execution.outcome.error).toMatchObject({ code: "public_root_conflict" });
      expect(execution.outcome.path).toEqual(["project-roots", "index-roots"]);
    }
    // Evidence accumulated before the failure is retained.
    expect(execution.outcome.notes).toEqual([
      { kind: "roots-merged", sealed: 1, hot: 1, merged: 2 },
    ]);
  });

  it("keeps sealed roots when a hot root reuses a sealed root identity", () => {
    const sealed = root("a", "0");
    const hot = { ...root("a", "0"), state: "mutable" as const };
    const execution = collectProjectionProgram(
      () =>
        liveProjection({
          sealed: rootMap(sealed),
          hot: rootMap(hot),
          liveEvents: [],
          requireComplete: false,
        }),
      (error) => error,
    );

    expect(execution.outcome.ok).toBe(true);
    expect(execution.outcome.notes[0]).toEqual({
      kind: "roots-merged",
      sealed: 1,
      hot: 1,
      merged: 1,
    });
  });
});
