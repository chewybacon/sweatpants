import type { D1Database, D1DatabaseSession, D1PreparedStatement } from "@cloudflare/workers-types";
import { call, sleep } from "effection";
import {
  evaluateMutation,
  evaluateMutationPreconditions,
  decodeDurableKey,
  validateMutationStructure,
  validateScan,
  planScanPage,
  parseCounter,
  sqlCounter,
  DurableKernelError,
  type DurableKernel,
  type StoredAuthorityRecord,
  type StoredImmutableRecord,
} from "@sweatpants/durable-storage-kernel";
import {
  columns,
  decodeRow,
  domainFor,
  fingerprint,
  identity,
  predicate,
  selection,
  tableName,
  type Domain,
  type Row,
} from "./domain.ts";
export interface D1KernelOptions {
  maxAttempts?: number;
}
type Stored = StoredAuthorityRecord | StoredImmutableRecord;
type Bind = string | number | null;
const gate = "(SELECT token FROM sp_d1_meta WHERE id=1)=?";
const INLINE_BYTES = 1024 * 1024;
// A UTF-16 code unit occupies at most three UTF-8 bytes. Never split a surrogate pair.
const CHUNK_CHARACTERS = 250_000;
function invalid(message: string): never {
  throw new DurableKernelError("durable_kernel_persisted_data_invalid", message);
}
function sqlIdentity(domain: Domain) {
  const defs = columns(domain);
  return `json_array(${domain.keys[0]!.map((key) => `CAST("${tableName(domain)}"."${defs[key!]!.name}" AS TEXT)`).join(",")})`;
}
function payloadSelection(domain: Domain, collection: string) {
  const key = sqlIdentity(domain);
  return `${selection(domain)}, (SELECT parts FROM sp_d1_payloads WHERE collection='${collection}' AND key=${key}) AS payloadParts`;
}
async function hydrate(
  session: D1DatabaseSession,
  collection: string,
  raw: Row,
  selectedChunks?: { part: number; value: string }[],
): Promise<Stored> {
  const domain = domainFor(collection);
  const row = decodeRow(domain, raw);
  const key = identity(domain, row);
  let value: unknown;
  if (row.payloadParts !== null) {
    const chunks =
      selectedChunks ??
      (
        await session
          .prepare(
            "SELECT part,value FROM sp_d1_payload_chunks WHERE collection=? AND key=? ORDER BY part",
          )
          .bind(collection, key)
          .all<{ part: number; value: string }>()
      ).results;
    if (chunks.length !== row.payloadParts || chunks.some((chunk, index) => chunk.part !== index)) {
      invalid("Missing journal payload chunk");
    }
    value = JSON.parse(chunks.map((chunk) => chunk.value).join(""));
  } else {
    const terminal =
      typeof row.terminalSegmentId === "string"
        ? await session
            .prepare(
              "SELECT CAST(last_position AS TEXT) AS lastPosition FROM sp_conversation_terminal_segments WHERE segment_id=?",
            )
            .bind(row.terminalSegmentId)
            .first<{ lastPosition: string }>()
        : null;
    value = domain.fromRow(row, terminal);
  }
  const base = { collection, key, value };
  return domain.revision
    ? {
        ...base,
        collection: collection as StoredAuthorityRecord["collection"],
        revision: String(row[domain.revision]),
        fence: domain.fence ? String(row[domain.fence]) : null,
      }
    : {
        ...base,
        collection: collection as StoredImmutableRecord["collection"],
        fingerprint: fingerprint(domain, row, value),
      };
}
async function read(
  session: D1DatabaseSession,
  collection: string,
  key: string,
): Promise<Stored | null> {
  const domain = domainFor(collection),
    where = predicate(domain, key);
  // Authority payload replacement and its metadata must be read in one snapshot.
  const rows = await session
    .prepare(
      `SELECT ${payloadSelection(domain, collection)}, c.part AS payloadPart, c.value AS payloadChunk FROM "${tableName(domain)}" LEFT JOIN sp_d1_payload_chunks c ON c.collection=? AND c.key=${sqlIdentity(domain)} WHERE ${where.sql} ORDER BY c.part`,
    )
    .bind(collection, ...where.args)
    .all<Row>();
  const row = rows.results[0];
  return row
    ? hydrate(
        session,
        collection,
        row,
        rows.results
          .filter((chunk) => chunk.payloadPart !== null)
          .map((chunk) => ({ part: Number(chunk.payloadPart), value: String(chunk.payloadChunk) })),
      )
    : null;
}
function prepareWrite(
  session: D1DatabaseSession,
  record: Stored,
  token: string,
): D1PreparedStatement[] {
  const domain = domainFor(record.collection),
    defs = columns(domain);
  const row = domain.toRow(record.value);
  if (identity(domain, row) !== record.key) {
    invalid("Record identity disagrees with domain value");
  }
  const statements: D1PreparedStatement[] = [];
  if (domain.revision) {
    statements.push(
      session
        .prepare(`DELETE FROM sp_d1_payload_chunks WHERE collection=? AND key=? AND ${gate}`)
        .bind(record.collection, record.key, token),
    );
    statements.push(
      session
        .prepare(`DELETE FROM sp_d1_payloads WHERE collection=? AND key=? AND ${gate}`)
        .bind(record.collection, record.key, token),
    );
  }
  const names = Object.keys(row),
    args: Bind[] = [];
  const values = names.map((name) => {
    const col = defs[name]!;
    let value = row[name];
    if (col.columnType === "SQLiteTextJson") {
      value = value === null ? (col.notNull ? "null" : null) : JSON.stringify(value);
    }
    if (col.columnType === "SQLiteCustomColumn") {
      value = String(col.mapToDriverValue(value));
    }
    args.push(value as Bind);
    return col.columnType === "SQLiteCustomColumn" ? "CAST(? AS INTEGER)" : "?";
  });
  // Size the actual encoded bindings once; only overflow needs a separate transport envelope.
  const transportBytes = args.reduce<number>(
    (total, value) =>
      total + (typeof value === "string" ? new TextEncoder().encode(value).byteLength : 8),
    0,
  );
  const overflow = transportBytes > INLINE_BYTES;
  const overflowPayloadBytes =
    overflow && record.collection === "conversation-terminal-segments"
      ? new TextEncoder().encode(args[names.indexOf("entriesJson")] as string).byteLength
      : null;
  if (overflow) {
    for (const [index, name] of names.entries()) {
      const col = defs[name]!;
      if (col.columnType === "SQLiteTextJson") {
        args[index] = col.notNull ? "null" : null;
      }
    }
  }
  const conflict = domain.revision
    ? `ON CONFLICT(${domain.keys[0]!.map((name) => `"${defs[name!]!.name}"`).join(",")}) DO UPDATE SET ${names
        .filter((name) => !domain.keys[0]!.includes(name))
        .map((name) => `"${defs[name]!.name}"=excluded."${defs[name]!.name}"`)
        .join(",")}`
    : "";
  statements.push(
    session
      .prepare(
        `INSERT INTO "${tableName(domain)}" (${names.map((name) => `"${defs[name]!.name}"`).join(",")}) SELECT ${values.join(",")} WHERE ${gate} ${conflict}`,
      )
      .bind(...args, token),
  );
  if (overflow) {
    const serialized = JSON.stringify(record.value);
    const chunks: string[] = [];
    for (let offset = 0; offset < serialized.length; ) {
      let end = Math.min(serialized.length, offset + CHUNK_CHARACTERS);
      if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1]!)) {
        end--;
      }
      chunks.push(serialized.slice(offset, end));
      offset = end;
    }
    statements.push(
      session
        .prepare(
          `INSERT INTO sp_d1_payloads(collection,key,parts,payload_bytes) SELECT ?,?,?,? WHERE ${gate}`,
        )
        .bind(record.collection, record.key, chunks.length, overflowPayloadBytes, token),
    );
    for (const [part, value] of chunks.entries()) {
      statements.push(
        session
          .prepare(
            `INSERT INTO sp_d1_payload_chunks(collection,key,part,value) SELECT ?,?,?,? WHERE ${gate}`,
          )
          .bind(record.collection, record.key, part, value, token),
      );
    }
  }
  return statements;
}
/** D1's batch is the atomic commit boundary; every domain write is guarded by the accepted read set. */
export function createD1DurableKernel(
  database: D1Database,
  options: D1KernelOptions = {},
): DurableKernel {
  const maxAttempts = options.maxAttempts ?? 32;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be positive");
  }
  return {
    *readAuthority(collection, key) {
      return (yield* call(() =>
        read(database.withSession("first-primary"), collection, key),
      )) as StoredAuthorityRecord | null;
    },
    *readImmutable(collection, key) {
      return (yield* call(() =>
        read(database.withSession("first-primary"), collection, key),
      )) as StoredImmutableRecord | null;
    },
    *apply(mutation) {
      validateMutationStructure(mutation);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const session = database.withSession("first-primary");
        const observations = new Map<
          string,
          { collection: string; key: string; record: Stored | null }
        >();
        const observe = async (collection: string, key: string) => {
          const id = JSON.stringify([collection, key]);
          let entry = observations.get(id);
          if (!entry) {
            entry = { collection, key, record: await read(session, collection, key) };
            observations.set(id, entry);
          }
          return entry.record;
        };
        const claim = mutation.claim
          ? ((yield* call(() =>
              observe(mutation.claim!.collection, mutation.claim!.key),
            )) as StoredImmutableRecord | null)
          : null;
        const authority =
          !claim && mutation.authority
            ? ((yield* call(() =>
                observe(mutation.authority!.collection, mutation.authority!.key),
              )) as StoredAuthorityRecord | null)
            : null;
        const precondition = evaluateMutationPreconditions(mutation, { claim, authority });
        if (precondition) {
          return precondition;
        }
        const candidates = new Map<string, StoredImmutableRecord[]>();
        for (const ensure of mutation.ensures) {
          const records: StoredImmutableRecord[] = [];
          for (const key of [ensure.key, ...(ensure.alternateKeys ?? [])]) {
            const record = yield* call(() => observe(ensure.collection, key));
            if (record) {
              records.push(record as StoredImmutableRecord);
            }
          }
          candidates.set(ensure.name, records);
          // Aliases are domain identities, never arbitrary redirects.
          const row = domainFor(ensure.collection).toRow(ensure.value);
          const domain = domainFor(ensure.collection);
          for (const key of [ensure.key, ...(ensure.alternateKeys ?? [])]) {
            const parts = decodeDurableKey(key),
              fields = domain.keys.find((candidate) => candidate.length === parts.length);
            if (
              !fields ||
              fields.some((field, index) => field !== null && String(row[field]) !== parts[index])
            ) {
              invalid("Immutable alias disagrees with domain value");
            }
          }
        }
        const plan = evaluateMutation(mutation, {
          claim,
          authority,
          candidates: (ensure) => candidates.get(ensure.name) ?? [],
        });
        if (plan.status !== "ready") {
          return plan;
        }
        if (!mutation.claim && plan.inserts.length === 0 && !plan.outcome.authority) {
          return plan.outcome;
        }
        // Group bounded input identities by domain index. SQL size depends on the
        // domain schema, not on the number of records in a maximum-size mutation.
        const groups = new Map<
          string,
          { domain: Domain; fields: readonly (string | null)[]; rows: unknown[][] }
        >();
        for (const observed of observations.values()) {
          const domain = domainFor(observed.collection);
          const parts = decodeDurableKey(observed.key);
          const fields = domain.keys.find((candidate) => candidate.length === parts.length)!;
          const groupKey = `${observed.collection}:${parts.length}`;
          let group = groups.get(groupKey);
          if (!group) {
            group = { domain, fields, rows: [] };
            groups.set(groupKey, group);
          }
          group.rows.push([
            ...parts,
            observed.record && "revision" in observed.record
              ? observed.record.revision
              : observed.record !== null
                ? 1
                : null,
          ]);
        }
        const guardValues: unknown[][][] = [];
        const guards: string[] = [];
        for (const { domain, fields, rows } of groups.values()) {
          const defs = columns(domain);
          const at = guardValues.length;
          guardValues.push(rows);
          const joins = fields.flatMap((field, index) =>
            field === null
              ? []
              : [
                  `actual."${defs[field]!.name}" = ${defs[field]!.columnType === "SQLiteCustomColumn" ? `CAST(json_extract(expected.value,'$[${index}]') AS INTEGER)` : `json_extract(expected.value,'$[${index}]')`}`,
                ],
          );
          const actual = domain.revision
            ? `CAST(actual."${defs[domain.revision]!.name}" AS TEXT)`
            : `CASE WHEN actual."${defs[domain.keys[0]![0]!]!.name}" IS NULL THEN NULL ELSE 1 END`;
          guards.push(
            `NOT EXISTS (SELECT 1 FROM json_each(json_extract((SELECT value FROM observed),'$[${at}]')) expected LEFT JOIN "${tableName(domain)}" actual ON ${joins.join(" AND ")} WHERE ${actual} IS NOT json_extract(expected.value,'$[${fields.length}]'))`,
          );
        }
        const token = crypto.randomUUID();
        const statements: D1PreparedStatement[] = [
          session
            .prepare(
              `WITH observed(value) AS (SELECT ?) UPDATE sp_d1_meta SET token=? WHERE id=1 AND ${guards.join(" AND ") || "1"} RETURNING token`,
            )
            .bind(JSON.stringify(guardValues), token),
        ];
        if (mutation.claim) {
          statements.push(...prepareWrite(session, mutation.claim, token));
        }
        for (const ensure of plan.inserts) {
          statements.push(...prepareWrite(session, plan.outcome.ensured[ensure.name]!, token));
        }
        if (plan.outcome.authority) {
          statements.push(...prepareWrite(session, plan.outcome.authority!, token));
        }
        for (const key of mutation.retireExecutionObjects ?? []) {
          const [objectId] = decodeDurableKey(key);
          statements.push(
            session
              .prepare(`DELETE FROM sp_execution_objects WHERE object_id=? AND ${gate}`)
              .bind(objectId!, token),
            session
              .prepare(
                `DELETE FROM sp_d1_payload_chunks WHERE collection='execution-objects' AND key=? AND ${gate}`,
              )
              .bind(key, token),
            session
              .prepare(
                `DELETE FROM sp_d1_payloads WHERE collection='execution-objects' AND key=? AND ${gate}`,
              )
              .bind(key, token),
          );
        }
        const result = yield* call(() => session.batch(statements));
        if (result[0]!.results.length) {
          return plan.outcome;
        }
        // Read the winning outcome even with a single allowed write attempt.
        if (attempt === maxAttempts - 1) {
          const winnerClaim = mutation.claim
            ? ((yield* call(() =>
                read(session, mutation.claim!.collection, mutation.claim!.key),
              )) as StoredImmutableRecord | null)
            : null;
          const winnerAuthority =
            !winnerClaim && mutation.authority
              ? ((yield* call(() =>
                  read(session, mutation.authority!.collection, mutation.authority!.key),
                )) as StoredAuthorityRecord | null)
              : null;
          const conflict = evaluateMutationPreconditions(mutation, {
            claim: winnerClaim,
            authority: winnerAuthority,
          });
          if (conflict) {
            return conflict;
          }
          const winners = new Map<string, StoredImmutableRecord[]>();
          for (const ensure of mutation.ensures) {
            const rows: StoredImmutableRecord[] = [];
            for (const key of [ensure.key, ...(ensure.alternateKeys ?? [])]) {
              const record = yield* call(() => read(session, ensure.collection, key));
              if (record) {
                rows.push(record as StoredImmutableRecord);
              }
            }
            winners.set(ensure.name, rows);
          }
          const outcome = evaluateMutation(mutation, {
            claim: winnerClaim,
            authority: winnerAuthority,
            candidates: (ensure) => winners.get(ensure.name) ?? [],
          });
          if (outcome.status !== "ready") {
            return outcome;
          }
          if (!mutation.claim && !outcome.outcome.authority && outcome.inserts.length === 0) {
            return outcome.outcome;
          }
        }
        yield* sleep(Math.min(50, 1 + attempt * 2));
      }
      throw new DurableKernelError(
        "durable_kernel_transaction_failed",
        "D1 journal contention exceeded the retry budget",
      );
    },
    *scan(request) {
      validateScan(request);
      const domain = domainFor(request.collection),
        defs = columns(domain),
        session = database.withSession("first-primary");
      const scope = decodeDurableKey(request.scope),
        task = request.index === "task-sequence";
      const position =
        "position" in defs
          ? "position"
          : "minPosition" in defs
            ? "minPosition"
            : "firstPosition" in defs
              ? "firstPosition"
              : "firstSequence";
      const scopes = task ? ["executionId", "taskId"] : ["conversationId"];
      const clauses = scopes.map((name) => `"${defs[name]!.name}"=?`),
        args: Bind[] = [...scope];
      const forward = request.direction === "forward";
      if (request.after !== null) {
        clauses.push(`"${defs[position]!.name}" ${forward ? ">" : "<"} CAST(? AS INTEGER)`);
        args.push(sqlCounter(request.after).toString());
      }
      if (request.through !== undefined) {
        clauses.push(`"${defs[position]!.name}" ${forward ? "<=" : ">="} CAST(? AS INTEGER)`);
        args.push(sqlCounter(request.through).toString());
      }
      const keyColumns = domain.keys[0]!;
      const payloadSize =
        request.collection === "conversation-public-root-index"
          ? "0"
          : request.collection === "conversation-terminal-segments"
            ? `COALESCE((SELECT payload_bytes FROM sp_d1_payloads WHERE collection='conversation-terminal-segments' AND key=${sqlIdentity(domain)}), octet_length(entries_json))`
            : "encoded_bytes";
      const metadata = yield* call(() =>
        session
          .prepare(
            `SELECT ${keyColumns.map((name) => `CAST("${defs[name!]!.name}" AS TEXT) AS "${name}"`).join(",")}, CAST("${defs[position]!.name}" AS TEXT) AS scanPosition, ${payloadSize} AS payloadBytes FROM "${tableName(domain)}" WHERE ${clauses.join(" AND ")} ORDER BY "${tableName(domain)}"."${defs[position]!.name}" ${forward ? "ASC" : "DESC"} LIMIT ?`,
          )
          .bind(...args, request.maxRecords + 1)
          .all<Row>(),
      );
      const page = planScanPage(
        request,
        metadata.results.map((row) => ({
          key: identity(domain, row),
          position: String(row.scanPosition),
          payloadBytes: Number(row.payloadBytes),
        })),
      );
      const found = new Map<string, Stored>();
      const groupSize = Math.floor(99 / keyColumns.length);
      for (let offset = 0; offset < page.selected.length; offset += groupSize) {
        const group = page.selected.slice(offset, offset + groupSize),
          matches = group.map((row) => predicate(domain, row.key));
        const rows = yield* call(() =>
          session
            .prepare(
              `SELECT ${payloadSelection(domain, request.collection)} FROM "${tableName(domain)}" WHERE ${matches.map((where) => `(${where.sql})`).join(" OR ")}`,
            )
            .bind(...matches.flatMap((where) => where.args))
            .all<Row>(),
        );
        for (const row of rows.results) {
          const record = yield* call(() => hydrate(session, request.collection, row));
          found.set(record.key, record);
        }
      }
      return {
        records: page.selected.map((selected) => {
          const record = found.get(selected.key);
          if (!record) {
            invalid("Missing indexed journal record");
          }
          return {
            ...(record as StoredImmutableRecord),
            position: selected.position,
            payloadBytes: selected.payloadBytes,
          };
        }),
        nextCursor: page.nextCursor,
      };
    },
    *waitForChange(request) {
      parseCounter(request.afterRevision, "wait revision");
      yield* sleep(Math.max(0, request.timeoutMs));
    },
  };
}
