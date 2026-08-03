import { describe, expect, it } from "vitest";
import {
  applyFrontendOverlay,
  applyHostToolResult,
  createOpaqueExecutionNode,
  foldHostTreeDeltas,
  type HostTreeDelta,
  type LocalRenderRecord,
} from "./recursive-tree.ts";

function message(nodeId: string, sequence: number) {
  return {
    type: "message" as const,
    id: nodeId,
    placement: { nodeId, parentNodeId: null, sequence },
    role: "assistant" as const,
    parts: [],
  };
}

describe("recursive host tree", () => {
  it("orders producer sequences despite shuffled delivery and ignores identical replay", () => {
    const first = message("first", 0);
    const second = message("second", 1);
    const deltas: HostTreeDelta[] = [
      { type: "tree_node_upsert", node: second },
      { type: "tree_node_upsert", node: first },
      { type: "tree_node_upsert", node: first },
    ];
    expect(foldHostTreeDeltas(deltas).messages.map((entry) => entry.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("buffers children and rejects unresolved parentage", () => {
    const child = createOpaqueExecutionNode({
      nodeId: "child",
      parentNodeId: "parent",
      sequence: 0,
      executionId: "child-execution",
    });
    expect(() => foldHostTreeDeltas([{ type: "tree_node_upsert", node: child }])).toThrow(
      /client_tree_parent_missing/,
    );
  });

  it("registers embedded execution anchors and materializes later children", () => {
    const execution = {
      type: "execution" as const,
      placement: { nodeId: "execution-1", parentNodeId: "root", sequence: 0 },
      executionId: "execution-1",
      presentation: "public" as const,
      status: "running" as const,
      children: [],
    };
    const root = {
      ...message("root", 0),
      parts: [
        {
          type: "tool-call" as const,
          id: "part-1",
          callId: "call-1",
          name: "tool",
          arguments: {},
          state: "running" as const,
          execution,
        },
      ],
    };
    const child = createOpaqueExecutionNode({
      nodeId: "child",
      parentNodeId: "execution-1",
      sequence: 0,
      executionId: "child-execution",
    });
    const settled = foldHostTreeDeltas([
      { type: "tree_node_upsert", node: root },
      { type: "tree_node_upsert", node: child },
      { type: "tree_node_settled", nodeId: "execution-1", status: "complete" },
    ]);
    const materializedExecution = settled.messages[0]?.parts[0];
    expect(materializedExecution?.type).toBe("tool-call");
    if (materializedExecution?.type !== "tool-call") {
      throw new Error("expected a tool call");
    }
    expect(materializedExecution.execution.status).toBe("complete");
    expect(materializedExecution.execution.children).toEqual([child]);
  });

  it("projects tool results into the placed tool call without changing ancestry", () => {
    const execution = {
      type: "execution" as const,
      placement: { nodeId: "execution-result", parentNodeId: "root-result", sequence: 0 },
      executionId: "execution-result",
      presentation: "public" as const,
      status: "running" as const,
      children: [],
    };
    const host = {
      messages: [
        {
          ...message("root-result", 0),
          parts: [
            {
              type: "tool-call" as const,
              id: "part-result",
              callId: "call-result",
              name: "tool",
              arguments: {},
              state: "running" as const,
              execution,
            },
          ],
        },
      ],
    };
    const result = applyHostToolResult(host, {
      callId: "call-result",
      content: "done",
      isError: false,
    });
    const part = result.messages[0]?.parts[0];
    expect(part).toMatchObject({ callId: "call-result", state: "complete", result: "done" });
    expect(part?.type === "tool-call" ? part.execution.placement : undefined).toEqual(
      execution.placement,
    );
    expect(host.messages[0]?.parts[0]).toMatchObject({ state: "running" });
  });

  it("rejects conflicting identity reuse", () => {
    const original = message("same", 0);
    const conflict = { ...message("same", 1), id: "same" };
    expect(() =>
      foldHostTreeDeltas([
        { type: "tree_node_upsert", node: original },
        { type: "tree_node_upsert", node: conflict },
      ]),
    ).toThrow(/client_tree_node_conflict/);
  });

  it("applies local render overlays immutably by exact elicitation identity", () => {
    const host = {
      messages: [
        {
          ...message("root", 0),
          parts: [],
        },
      ],
    };
    const records = new Map<string, readonly LocalRenderRecord<string>[]>([
      [
        "elicit-a",
        [{ renderId: "render-a", parentElicitId: "elicit-a", sequence: 0, prepared: "A" }],
      ],
    ]);
    const projected = applyFrontendOverlay(host, {
      renders: records,
      prepare: (record) => record.prepared,
    });
    expect(projected).not.toBe(host.messages);
    expect(host.messages[0]?.parts).toEqual([]);
  });
});
