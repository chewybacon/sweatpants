import { enrichPlacementAnchors } from "../placement-anchors.ts";
import { run, type Operation, type Scope } from "effection";
import { decodePublicProjectionRoot } from "@sweatpants/chat-core";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import { ConversationStoreError } from "@sweatpants/history-store/contract";

import {
  DEFAULT_HISTORY_PAGE_BYTE_LIMIT,
  DEFAULT_HISTORY_PAGE_ROOT_LIMIT,
  DEFAULT_PROJECTION_TOKEN_TTL_MS,
} from "../conversation-persistence.ts";
import {
  mintPublicHistoryCursor,
  ProjectionTokenError,
  verifyPublicHistoryCursor,
} from "../projection-tokens.ts";
import type { ScopedEndpoint } from "../streaming.ts";
import type { ProjectionTokenKeyring } from "../projection-tokens.ts";
import type { DurableHistoryPageRequest, HistoryReadAuthorization } from "./types.ts";

/** Resolved authority pieces required to serve archived history pages. */
export interface HistoryPageEndpointConfig {
  readonly projectionTokens: ProjectionTokenKeyring;
  readonly projectionTokenTtlMs?: number;
  readonly authorizeHistoryRead: (
    request: Request,
    conversationId: string,
  ) => Operation<HistoryReadAuthorization>;
}

async function readHistoryCursorBody(request: Request): Promise<string> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 128 * 1024) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "History page body exceeds 128 KiB",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "History page body must be valid JSON",
    );
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as Record<string, unknown>)["cursor"] !== "string"
  ) {
    throw new ProjectionTokenError(
      "public_history_cursor_invalid",
      "History page body must contain exactly one cursor",
    );
  }
  return (value as { cursor: string }).cursor;
}

async function createHistoryPageResponse(params: {
  request: Request;
  conversationId: string;
  store: ConversationStore;
  config: HistoryPageEndpointConfig;
  scope?: Scope;
}): Promise<Response> {
  const execute = <T>(operation: () => Operation<T>): Promise<T> =>
    params.scope ? params.scope.run(operation) : run(operation);
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
  });
  const authorization = await execute(() =>
    params.config.authorizeHistoryRead(params.request, params.conversationId),
  );
  if (authorization === "unauthenticated") {
    return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401, headers });
  }
  if (authorization === "forbidden") {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers });
  }
  try {
    const token = await readHistoryCursorBody(params.request);
    const now = Date.now();
    const cursor = await verifyPublicHistoryCursor(token, params.config.projectionTokens);
    const head = await execute(() => params.store.loadHead(params.conversationId));
    if (!head) {
      return new Response(JSON.stringify({ error: "conversation_not_found" }), {
        status: 404,
        headers,
      });
    }
    if (head.state === "deleted") {
      return new Response(JSON.stringify({ error: "conversation_deleted" }), {
        status: 410,
        headers,
      });
    }
    const checkpointPointer = head.checkpoint;
    if (!checkpointPointer) {
      return new Response(JSON.stringify({ error: "conversation_not_found" }), {
        status: 404,
        headers,
      });
    }
    const checkpoint = await execute(() => params.store.getCheckpoint(checkpointPointer));
    if (
      !checkpoint ||
      checkpoint.lineageId !== cursor.lineageId ||
      BigInt(cursor.archiveFrontierOrdinal) > BigInt(checkpoint.archiveFrontierOrdinal) ||
      BigInt(cursor.nextPublicPosition) > BigInt(checkpoint.nextPublicPosition)
    ) {
      return new Response(JSON.stringify({ error: "public_history_frontier_changed" }), {
        status: 409,
        headers,
      });
    }
    const page = await execute(() =>
      params.store.readPublicHistoryBefore({
        conversationId: params.conversationId,
        basis: cursor,
        beforePosition: cursor.beforePosition,
        maxRoots: DEFAULT_HISTORY_PAGE_ROOT_LIMIT,
        maxBytes: DEFAULT_HISTORY_PAGE_BYTE_LIMIT,
      }),
    );
    const roots = await execute(() =>
      enrichPlacementAnchors(
        params.store,
        params.conversationId,
        cursor,
        page.roots.map((root) => decodePublicProjectionRoot(root)),
      ),
    );
    const nextOlderCursor = page.nextBeforePosition
      ? await mintPublicHistoryCursor(
          {
            ...cursor,
            beforePosition: page.nextBeforePosition,
            issuedAt: now,
            expiresAt:
              now + (params.config.projectionTokenTtlMs ?? DEFAULT_PROJECTION_TOKEN_TTL_MS),
          },
          params.config.projectionTokens,
        )
      : null;
    return new Response(JSON.stringify({ roots, nextOlderCursor }), { status: 200, headers });
  } catch (error) {
    if (error instanceof ProjectionTokenError) {
      return new Response(JSON.stringify({ error: error.code }), {
        status: error.code === "public_history_cursor_expired" ? 409 : 400,
        headers,
      });
    }
    if (error instanceof ConversationStoreError && error.code === "public_root_conflict") {
      return new Response(JSON.stringify({ error: error.code }), { status: 409, headers });
    }
    throw error;
  }
}

/** Route-independent archived history endpoint. */
export function createDurableHistoryPageEndpoint(
  config: HistoryPageEndpointConfig,
  store: ConversationStore,
): ScopedEndpoint<DurableHistoryPageRequest> {
  const endpoint = (input: DurableHistoryPageRequest): Promise<Response> =>
    createHistoryPageResponse({ ...input, store, config });
  endpoint.withScope = (scope: Scope) => (input: DurableHistoryPageRequest) =>
    createHistoryPageResponse({ ...input, store, config, scope });
  return endpoint;
}
