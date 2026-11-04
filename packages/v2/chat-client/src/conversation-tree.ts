import type { QuestionContract, ConversationNode, ConversationPart } from "./contracts.ts";

/** Materialize explicit placement. Missing parents, cycles and duplicate sibling
 * positions fail visibly; never infer a parent from the last message to arrive. */
export function materializeConversation<Q extends QuestionContract, Result = string>(
  nodes: readonly ConversationNode<Q, Result>[],
): readonly ConversationPart<Q, Result>[] {
  // Traversal only inspects placement and container kinds. Erase application
  // payload types internally; retain the original objects without reinterpretation.
  const records = nodes as readonly ConversationNode<QuestionContract, Result>[];
  const byId = new Map(records.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) {
    throw new Error("Duplicate conversation node");
  }
  const children = new Map<string | null, ConversationNode<QuestionContract, Result>[]>();
  for (const node of records) {
    if (!Number.isSafeInteger(node.order) || node.order < 0) {
      throw new Error("Invalid conversation placement");
    }
    if (node.parentId !== null) {
      const parent = byId.get(node.parentId);
      if (!parent) {
        throw new Error("Missing conversation parent");
      }
      if (parent.type !== "message" && parent.type !== "tool-call") {
        throw new Error("Conversation parent cannot contain children");
      }
    }
    const siblings = children.get(node.parentId) ?? [];
    if (siblings.some((sibling) => sibling.order === node.order)) {
      throw new Error("Duplicate conversation placement");
    }
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const visited = new Set<string>();
  function parts(parentId: string | null): readonly ConversationPart<QuestionContract, Result>[] {
    return [...(children.get(parentId) ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((node) => {
        if (visited.has(node.id)) {
          throw new Error("Cyclic conversation placement");
        }
        visited.add(node.id);
        const { parentId: _parent, order: _order, ...value } = node;
        return value.type === "message" || value.type === "tool-call"
          ? { ...value, parts: parts(value.id) }
          : value;
      });
  }
  const result = parts(null);
  if (visited.size !== nodes.length) {
    throw new Error("Unreachable conversation nodes");
  }
  // Placement removal and child attachment never change a question's kind,
  // context, state or response. Restore the caller's correlated payload union.
  return result as readonly ConversationPart<Q, Result>[];
}

/** Concatenate only direct text parts; excludes nested messages and tool results. */
export function conversationText<Q extends QuestionContract, Result = string>(
  parts: readonly ConversationPart<Q, Result>[],
): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
