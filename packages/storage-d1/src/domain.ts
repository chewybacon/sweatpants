import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { canonicalDigest } from "@sweatpants/foundation";
import {
  decodeDurableKey,
  durableKey,
  DurableKernelError,
} from "@sweatpants/durable-storage-kernel";
import * as schema from "@sweatpants/storage-sqlite/schema";
import {
  headFromRow,
  headToRow,
  receiptFromRow,
  receiptToRow,
  checkpointFromRow,
  checkpointToRow,
  publicFromRow,
  publicToRow,
  publicRootIndexFromRow,
  publicRootIndexToRow,
  terminalFromRow,
  terminalToRow,
} from "@sweatpants/history-store/sql-codec";
import {
  controlFromRow,
  controlToRow,
  privateFromRow,
  privateToRow,
  objectFromRow,
  objectToRow,
} from "@sweatpants/journal-authority/sql-codec";
export type Row = Record<string, unknown>;
export interface Domain {
  table: SQLiteTable;
  keys: readonly (readonly (string | null)[])[];
  revision?: string;
  fence?: string;
  fingerprint?: string;
  toRow(value: unknown): Row;
  fromRow(row: Row, terminal?: { lastPosition: string } | null): unknown;
}
export const domains: Record<string, Domain> = {
  "conversation-heads": {
    table: schema.spConversationHeads,
    keys: [["conversationId"]],
    revision: "revision",
    fence: "ownerEpoch",
    toRow(value) {
      const parsed = value as Parameters<typeof headToRow>[0];
      return { conversationId: parsed.conversationId, ...headToRow(parsed) };
    },
    fromRow(row, terminal) {
      return headFromRow(row as Parameters<typeof headFromRow>[0], terminal);
    },
  },
  "conversation-command-receipts": {
    table: schema.spConversationCommandReceipts,
    keys: [["conversationId", "commandId"]],
    fingerprint: "commandDigest",
    toRow(value) {
      const parsed = value as Parameters<typeof receiptToRow>[0];
      return receiptToRow(parsed);
    },
    fromRow(row) {
      return receiptFromRow(row as Parameters<typeof receiptFromRow>[0]);
    },
  },
  "conversation-checkpoints": {
    table: schema.spConversationCheckpoints,
    keys: [["checkpointId"], ["conversationId", "causeKey"]],
    fingerprint: "contentHash",
    toRow(value) {
      const parsed = value as Parameters<typeof checkpointToRow>[0];
      return checkpointToRow(parsed);
    },
    fromRow(row) {
      return checkpointFromRow(row as Parameters<typeof checkpointFromRow>[0]);
    },
  },
  "conversation-public-segments": {
    table: schema.spConversationPublicSegments,
    keys: [["segmentId"], ["conversationId", "minPosition", "segmentId"]],
    fingerprint: "contentHash",
    toRow(value) {
      const parsed = value as Parameters<typeof publicToRow>[0];
      return publicToRow(parsed);
    },
    fromRow(row) {
      return publicFromRow(row as Parameters<typeof publicFromRow>[0]);
    },
  },
  "conversation-public-root-index": {
    table: schema.spConversationPublicRootIndex,
    keys: [
      ["conversationId", "position"],
      ["conversationId", null, "rootId"],
    ],
    toRow(value) {
      const parsed = value as Parameters<typeof publicRootIndexToRow>[0];
      return publicRootIndexToRow(parsed);
    },
    fromRow(row) {
      return publicRootIndexFromRow(row as Parameters<typeof publicRootIndexFromRow>[0]);
    },
  },
  "conversation-terminal-segments": {
    table: schema.spConversationTerminalSegments,
    keys: [
      ["segmentId"],
      ["conversationId", "publicationKey"],
      ["conversationId", "firstPosition", "segmentId"],
    ],
    fingerprint: "contentHash",
    toRow(value) {
      const parsed = value as Parameters<typeof terminalToRow>[0];
      return terminalToRow(parsed);
    },
    fromRow(row) {
      return terminalFromRow(row as Parameters<typeof terminalFromRow>[0]);
    },
  },
  "execution-controls": {
    table: schema.spExecutionControl,
    keys: [["executionId"]],
    revision: "controlRevision",
    fence: "ownerFence",
    toRow(value) {
      const parsed = value as Parameters<typeof controlToRow>[0];
      return { executionId: parsed.executionId, ...controlToRow(parsed) };
    },
    fromRow(row) {
      return controlFromRow(row as Parameters<typeof controlFromRow>[0]);
    },
  },
  "execution-journal-segments": {
    table: schema.spExecutionJournalSegments,
    keys: [["segmentId"], ["executionId", "taskId", "firstSequence", "lastSequence"]],
    fingerprint: "contentHash",
    toRow(value) {
      const parsed = value as Parameters<typeof privateToRow>[0];
      return privateToRow(parsed);
    },
    fromRow(row) {
      return privateFromRow(row as Parameters<typeof privateFromRow>[0]);
    },
  },
  "execution-replay-segments": {
    table: schema.spExecutionReplaySegments,
    keys: [["segmentId"], ["executionId", "taskId", "firstSequence", "lastSequence"]],
    fingerprint: "contentHash",
    toRow(value) {
      const parsed = value as Parameters<typeof privateToRow>[0];
      return privateToRow(parsed);
    },
    fromRow(row) {
      return privateFromRow(row as Parameters<typeof privateFromRow>[0]);
    },
  },
  "execution-objects": {
    table: schema.spExecutionObjects,
    keys: [["objectId"]],
    fingerprint: "contentHash",
    toRow(value) {
      const parsed = value as Parameters<typeof objectToRow>[0];
      return objectToRow(parsed);
    },
    fromRow(row) {
      return objectFromRow(row as Parameters<typeof objectFromRow>[0]);
    },
  },
};
export function domainFor(collection: string): Domain {
  const domain = domains[collection];
  if (!domain) {
    throw new DurableKernelError(
      "durable_kernel_persisted_data_invalid",
      `Unknown collection ${collection}`,
    );
  }
  return domain;
}
export function columns(domain: Domain) {
  return getTableColumns(domain.table);
}
export function tableName(domain: Domain) {
  return getTableName(domain.table);
}
export function identity(domain: Domain, row: Row): string {
  return durableKey(...domain.keys[0]!.map((key) => String(row[key!])));
}
export function fingerprint(domain: Domain, row: Row, value: unknown): string {
  return domain.fingerprint ? String(row[domain.fingerprint]) : canonicalDigest(value);
}
export function predicate(domain: Domain, key: string): { sql: string; args: string[] } {
  const parts = decodeDurableKey(key);
  const keys = domain.keys.find((candidate) => candidate.length === parts.length);
  if (!keys) {
    throw new DurableKernelError(
      "durable_kernel_persisted_data_invalid",
      `Unsupported domain identity ${key}`,
    );
  }
  const defs = columns(domain);
  return {
    sql: keys
      .flatMap((name) =>
        name
          ? [
              `"${defs[name]!.name}" = ${defs[name]!.columnType === "SQLiteCustomColumn" ? "CAST(? AS INTEGER)" : "?"}`,
            ]
          : [],
      )
      .join(" AND "),
    args: parts.flatMap((part, index) => {
      const name = keys[index];
      return name === null
        ? []
        : [
            defs[name!]!.columnType === "SQLiteCustomColumn"
              ? String(defs[name!]!.mapToDriverValue(part))
              : part,
          ];
    }),
  };
}
// durableCounter is the shared schema's only custom column: keep its exact
// integer representation across D1's JavaScript number transport.
export function selection(domain: Domain): string {
  return Object.entries(columns(domain))
    .map(
      ([key, col]) =>
        `${col.columnType === "SQLiteCustomColumn" ? `CAST("${col.name}" AS TEXT)` : `"${col.name}"`} AS "${key}"`,
    )
    .join(",");
}
export function decodeRow(domain: Domain, row: Row): Row {
  for (const [key, col] of Object.entries(columns(domain))) {
    if (col.columnType === "SQLiteTextJson" && typeof row[key] === "string") {
      row[key] = JSON.parse(row[key] as string);
    }
  }
  return row;
}
