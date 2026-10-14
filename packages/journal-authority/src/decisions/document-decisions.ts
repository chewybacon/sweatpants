import { canonicalDigest, stableTupleHash, type Json } from "@sweatpants/foundation";
import {
  CrankError,
  assertInlineSize,
  documentRequestSchema,
  applyDocumentPatches,
  type DocumentResult,
  type DocumentRequest,
  type WorkflowDocumentState,
} from "@sweatpants/durable-execution";
import type { DecisionDraft } from "./decision-draft.ts";
import { pullById } from "./decision-state.ts";

import type { DocumentCommandRequest } from "../contract/document-command.ts";

/** Host-only command. Identity and scope come from an existing admitted effect pull. */
export function operateDocument(
  draft: DecisionDraft,
  request: DocumentCommandRequest,
): DocumentResult {
  const task = draft.readTask(request.sessionId, request.taskId);
  const pull = pullById(task, request.pullId);
  const descriptor = pull.request.proposedDescriptor;
  if (
    descriptor.kind !== "effect" ||
    descriptor.name !== "document.operate" ||
    descriptor.version !== "1" ||
    canonicalDigest(descriptor.input) !== canonicalDigest(request.input)
  ) {
    throw new CrankError("invalid_descriptor", "Document request does not match its admitted pull");
  }
  const input = documentRequestSchema.parse(request.input);
  const previous = draft.readSession(request.sessionId).control.documents ?? {
    documents: [],
    receipts: [],
  };
  const key = stableTupleHash([request.taskId, request.pullId]);
  const digest = canonicalDigest(request.input);
  const receipt = previous.receipts.find((entry) => entry.key === key);
  if (receipt) {
    if (receipt.digest !== digest) {
      throw new CrankError("invalid_descriptor", "Document operation identity reused");
    }
    return structuredClone(receipt.result);
  }
  draft.assertActive(task);
  if (
    !pull.attempts.some(
      (attempt) => attempt.attemptId === request.attemptId && attempt.status === "started",
    ) ||
    pull.resolution.revoked
  ) {
    throw new CrankError("invalid_descriptor", "Document operation has no live admitted attempt");
  }
  let root = task;
  while (root.origin.kind === "child") {
    root = draft.readTask(request.sessionId, root.origin.invokedBy.taskId);
  }
  const state = structuredClone(previous);
  const activeOwners = new Set(
    [...draft.readSession(request.sessionId).execution.tasks.values()]
      .filter((entry) => entry.origin.kind === "root" && entry.lifecycle.status === "active")
      .map((entry) => entry.taskId),
  );
  state.documents = state.documents.filter((entry) => activeOwners.has(entry.owner));
  state.receipts = state.receipts.filter((entry) => activeOwners.has(entry.owner));
  if (state.receipts.length >= 512) {
    throw new CrankError("invalid_descriptor", "Workflow document receipt limit reached");
  }
  const result = transition(state, input, root.taskId, stableTupleHash([request.sessionId, key]));
  assertInlineSize(result, draft.maxOutcomeBytes);
  state.receipts.push({ owner: root.taskId, key, digest, result });
  assertInlineSize(state, 1_048_576);
  const session = draft.session(request.sessionId);
  session.control.documents = state;
  session.control.revision += 1;
  return structuredClone(result);
}

function transition(
  state: WorkflowDocumentState,
  request: DocumentRequest,
  owner: string,
  id: string,
): DocumentResult {
  if (request.operation === "create") {
    if (state.documents.length >= 32) {
      return { status: "error", code: "limit_exceeded" };
    }
    let content: Json;
    try {
      content = applyDocumentPatches(request.content, [
        { op: "set", path: [], value: request.content },
      ]);
    } catch {
      return { status: "error", code: "limit_exceeded" };
    }
    const current = { document: { id }, name: request.name, revision: 1, content };
    state.documents.push({ owner, current, history: [] });
    return { status: "ok", observation: { current, changes: { kind: "reset" } } };
  }
  const doc = state.documents.find(
    (entry) => entry.owner === owner && entry.current.document.id === request.document.id,
  );
  if (!doc) {
    return { status: "error", code: "not_found" };
  }
  if (request.operation === "read") {
    const from = request.sinceRevision;
    if (from !== undefined && from > doc.current.revision) {
      return { status: "error", code: "invalid_revision" };
    }
    const changes =
      from !== undefined &&
      from > 0 &&
      from >= (doc.history[0]?.revision ?? doc.current.revision + 1) - 1
        ? {
            kind: "delta" as const,
            from,
            to: doc.current.revision,
            patches: doc.history
              .filter((entry) => entry.revision > from)
              .flatMap((entry) => entry.patches),
          }
        : { kind: "reset" as const };
    return { status: "ok", observation: { current: doc.current, changes } };
  }
  if (request.expectedRevision !== doc.current.revision) {
    return { status: "conflict", current: doc.current };
  }
  let content: Json;
  try {
    content = applyDocumentPatches(doc.current.content, request.patches);
  } catch {
    return { status: "error", code: "invalid_patch" };
  }
  const from = doc.current.revision;
  doc.current = { ...doc.current, revision: from + 1, content };
  doc.history.push({ revision: from + 1, patches: request.patches });
  doc.history = doc.history.slice(-32);
  return {
    status: "ok",
    observation: {
      current: doc.current,
      changes: { kind: "delta", from, to: from + 1, patches: request.patches },
    },
  };
}
