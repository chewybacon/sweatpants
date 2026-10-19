/**
 * Durable chat configuration resolution.
 *
 * A handler composition needs three authority pieces: a workflow journal
 * store, projection-token keys, and a history-read authorizer. Applications
 * either supply them explicitly, or supply `{ name, secret }` and let this
 * module derive conventional defaults:
 *
 * - journal audience and prefix: `${name}-program-driver`
 * - journal capability key id:   `${name}-program-driver-v1`
 * - projection tokens:           HMAC keyring over `secret`
 * - history reads:               authorized (place auth in front, or override)
 */
import { dirname } from "node:path";
import type { Operation } from "effection";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { createProjectionTokenKeyring, type ProjectionTokenKeyring } from "../projection-tokens.ts";
import {
  createProgramDriverJournalStore,
  programDriverSchemaRegistry,
  type ProgramDriverJournalStore,
} from "./program-driver-journal.ts";
import type { DurableChatHandlerConfig, HistoryReadAuthorization } from "./types.ts";

/** Fully resolved authority composition consumed by the handler. */
export interface ResolvedDurableChatComposition {
  readonly createJournalStore: (executionStore: ExecutionStore) => ProgramDriverJournalStore;
  readonly projectionTokens: ProjectionTokenKeyring;
  readonly authorizeHistoryRead: (
    request: Request,
    conversationId: string,
  ) => Operation<HistoryReadAuthorization>;
}

const MIN_SECRET_UTF8_BYTES = 32;

function* authorizedHistoryRead(): Operation<HistoryReadAuthorization> {
  return "authorized";
}

/**
 * Validates a durable chat handler config and resolves the authority
 * composition, deriving conventional defaults from `{ name, secret }` when
 * explicit pieces are absent. Throws `TypeError` with an actionable message
 * for every invalid combination; there is no silent fallback.
 */
export function resolveDurableChatComposition(
  config: DurableChatHandlerConfig,
): ResolvedDurableChatComposition {
  if (config.programs && config.createProgramDriverJournalStore) {
    throw new TypeError(
      "Durable chat `programs` cannot be combined with `createProgramDriverJournalStore`; " +
        "pass a schemaRegistry to your journal store instead",
    );
  }
  const authorizeHistoryRead = config.authorizeHistoryRead ?? authorizedHistoryRead;
  const { secret, name } = config;
  const dataDirectory =
    config.storage.kind === "sqlite" && "path" in config.storage
      ? dirname(config.storage.path)
      : undefined;

  if (secret === undefined) {
    const { createProgramDriverJournalStore: createJournalStore, projectionTokens } = config;
    if (!createJournalStore || !projectionTokens) {
      throw new TypeError(
        "Durable chat configuration requires either { name, secret } or explicit " +
          "{ createProgramDriverJournalStore, projectionTokens }",
      );
    }
    return { createJournalStore, projectionTokens, authorizeHistoryRead };
  }

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("Durable chat `secret` requires a non-empty `name`");
  }
  if (new TextEncoder().encode(secret).byteLength < MIN_SECRET_UTF8_BYTES) {
    throw new TypeError(
      `Durable chat \`secret\` must contain at least ${MIN_SECRET_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  const audience = `${name.trim()}-program-driver`;
  const programs = config.programs ?? [];
  const createJournalStore =
    config.createProgramDriverJournalStore ??
    ((executionStore: ExecutionStore): ProgramDriverJournalStore =>
      createProgramDriverJournalStore({
        keyring: createCapabilityKeyring(audience, [{ keyId: `${audience}-v1`, secret }]),
        journalPrefix: audience,
        schemaRegistry: programDriverSchemaRegistry(
          programs.flatMap((program) => [...program.artifacts.catalog]),
        ),
        executionStore,
        dataDirectory: dataDirectory ? dataDirectory : undefined,
      }));

  return {
    createJournalStore,
    projectionTokens: config.projectionTokens ?? createProjectionTokenKeyring(secret),
    authorizeHistoryRead,
  };
}
