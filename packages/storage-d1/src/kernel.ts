import type { D1Database, D1DatabaseSession, D1PreparedStatement } from "@cloudflare/workers-types";
import { call, sleep, type Operation } from "effection";
import {
  evaluateMutation,
  decodeDurableKey,
  durableKey,
  parseCounter,
  validateMutationStructure,
  validateScan,
  planScanPage,
  DurableKernelError,
  type DurableKernel,
  type DurableMutationOutcome,
  type StoredAuthorityRecord,
  type StoredImmutableRecord,
} from "@sweatpants/durable-storage-kernel";

export interface D1KernelOptions {
  /** Bound retries when a writer changes one of this mutation's identities. */
  maxAttempts?: number;
}
interface Row {
  collection: string;
  key: string;
  revision: string | null;
  fence: string | null;
  fingerprint: string | null;
  byte_length: number;
  part: number | null;
  value: number[] | ArrayBuffer | null;
}
const CHUNK_BYTES = 1024 * 1024;
const gate = "(SELECT token FROM sp_d1_meta WHERE id=1)=?";
function readStatement(
  session: D1DatabaseSession,
  collection: string,
  key: string,
  immutable: boolean,
) {
  return session
    .prepare(`SELECT r.*, c.part, c.value FROM sp_d1_records r
    LEFT JOIN sp_d1_chunks c ON c.collection=r.collection AND c.key=r.key
    WHERE r.collection=? AND r.key=${
      immutable ? "(SELECT key FROM sp_d1_aliases WHERE collection=? AND alias=?)" : "?"
    }
    ORDER BY c.part`)
    .bind(...(immutable ? [collection, collection, key] : [collection, key]));
}
function record(rows: Row[]): StoredAuthorityRecord | StoredImmutableRecord | null {
  if (!rows.length) return null;
  const first = rows[0]!;
  const value = new Uint8Array(first.byte_length);
  let offset = 0;
  for (const [part, row] of rows.entries()) {
    if (row.part === null && value.length === 0) continue;
    if (row.part !== part || row.value === null) throw corrupt("Missing journal chunk");
    const chunk = new Uint8Array(row.value);
    if (offset + chunk.length > value.length) throw corrupt("Invalid journal chunk length");
    value.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== value.length) throw corrupt("Incomplete journal record");
  if (first.revision !== null)
    return {
      collection: first.collection as StoredAuthorityRecord["collection"],
      key: first.key,
      revision: first.revision,
      fence: first.fence,
      value,
    };
  if (first.fingerprint === null) throw corrupt("Missing immutable fingerprint");
  return {
    collection: first.collection as StoredImmutableRecord["collection"],
    key: first.key,
    fingerprint: first.fingerprint,
    value,
  };
}
function corrupt(message: string) {
  return new DurableKernelError("durable_kernel_persisted_data_invalid", message);
}
function position(collection: string, keys: readonly string[]) {
  const task =
    collection === "execution-journal-segments" || collection === "execution-replay-segments";
  const root = collection === "conversation-public-root-index";
  if (
    !task &&
    !root &&
    collection !== "conversation-public-segments" &&
    collection !== "conversation-terminal-segments"
  )
    return null;
  const tuple = keys
    .map(decodeDurableKey)
    .find((parts) => parts.length === (task ? 4 : root ? 2 : 3));
  if (!tuple) return null;
  const value = tuple[task ? 2 : 1]!;
  parseCounter(value, "stored scan position");
  return {
    index: task ? "task-sequence" : "conversation-position",
    scope: durableKey(...tuple.slice(0, task ? 2 : 1)),
    value,
  };
}

/** D1 batches are the commit boundary. Validate the read set, then gate all writes with a batch token. */
export function createD1DurableKernel(
  database: D1Database,
  options: D1KernelOptions = {},
): DurableKernel {
  const maxAttempts = options.maxAttempts ?? 32;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new RangeError("maxAttempts must be positive");
  const kernel: DurableKernel = {
    *readAuthority(collection, key) {
      const session = database.withSession("first-primary");
      const result = yield* call(() => readStatement(session, collection, key, false).all<Row>());
      return record(result.results) as StoredAuthorityRecord | null;
    },
    *readImmutable(collection, key) {
      const session = database.withSession("first-primary");
      const result = yield* call(() => readStatement(session, collection, key, true).all<Row>());
      return record(result.results) as StoredImmutableRecord | null;
    },
    *apply(mutation): Operation<DurableMutationOutcome> {
      validateMutationStructure(mutation);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const session = database.withSession("first-primary");
        const queries: D1PreparedStatement[] = [];
        const identities: { collection: string; key: string; immutable: boolean }[] = [];
        const slots = new Map<string, number>();
        const add = (collection: string, key: string, immutable: boolean) => {
          identities.push({ collection, key, immutable });
          slots.set(JSON.stringify([collection, key]), queries.length);
          queries.push(readStatement(session, collection, key, immutable));
        };
        if (mutation.claim) add(mutation.claim.collection, mutation.claim.key, true);
        if (mutation.authority) add(mutation.authority.collection, mutation.authority.key, false);
        for (const ensure of mutation.ensures)
          for (const key of [ensure.key, ...(ensure.alternateKeys ?? [])])
            add(ensure.collection, key, true);
        const snapshot = yield* call(() => session.batch(queries));
        const read = (collection: string, key: string) =>
          record(
            snapshot[slots.get(JSON.stringify([collection, key]))!]!.results as unknown as Row[],
          );
        const claim = mutation.claim
          ? (read(mutation.claim.collection, mutation.claim.key) as StoredImmutableRecord | null)
          : null;
        const current =
          !claim && mutation.authority
            ? (read(
                mutation.authority.collection,
                mutation.authority.key,
              ) as StoredAuthorityRecord | null)
            : null;
        const plan = evaluateMutation(mutation, {
          claim,
          authority: current,
          candidates: (ensure) =>
            [ensure.key, ...(ensure.alternateKeys ?? [])]
              .map((key) => read(ensure.collection, key) as StoredImmutableRecord | null)
              .filter((candidate) => candidate !== null),
        });
        if (plan.status !== "ready") return plan;
        // Existing immutable identities cannot retarget, and this plan makes no changes.
        // Replaying an ensure-only mutation needs no latch rotation or billable write.
        if (!mutation.claim && plan.inserts.length === 0 && !plan.outcome.authority) {
          return plan.outcome;
        }
        const token = crypto.randomUUID();
        // Validate only identities this mutation observed. A database-wide CAS
        // would make unrelated conversations retry each other's successful writes.
        // Immutable aliases never retarget; authority revisions advance on every
        // replacement. Together these predicates cover the complete read set.
        const aliases = identities
          .filter((identity) => identity.immutable)
          .map(({ collection, key }) => [collection, key, read(collection, key)?.key ?? null]);
        const conditions = [
          `NOT EXISTS (
          SELECT 1 FROM json_each(?) expected
          LEFT JOIN sp_d1_aliases a ON a.collection=json_extract(expected.value,'$[0]')
            AND a.alias=json_extract(expected.value,'$[1]')
          WHERE a.key IS NOT json_extract(expected.value,'$[2]'))`,
        ];
        const guardArgs: (string | null)[] = [JSON.stringify(aliases)];
        if (mutation.authority) {
          conditions.push("(SELECT revision FROM sp_d1_records WHERE collection=? AND key=?) IS ?");
          guardArgs.push(
            mutation.authority.collection,
            mutation.authority.key,
            current?.revision ?? null,
          );
        }
        // D1 executes the whole batch as one transaction. Once the read set is
        // accepted, no other batch can replace this token between our statements.
        // The token is a transaction latch, not a cross-transaction CAS version.
        const statements: D1PreparedStatement[] = [
          session
            .prepare(
              `UPDATE sp_d1_meta SET token=? WHERE id=1 AND ${conditions.join(" AND ")} RETURNING token`,
            )
            .bind(token, ...guardArgs),
        ];
        const write = (
          record: StoredAuthorityRecord | StoredImmutableRecord,
          aliases?: readonly string[],
        ) => {
          const authority = "revision" in record;
          statements.push(
            session
              .prepare(`INSERT INTO sp_d1_records(collection,key,revision,fence,fingerprint,byte_length)
            SELECT ?,?,?,?,?,? WHERE ${gate} ON CONFLICT(collection,key) DO UPDATE SET
            revision=excluded.revision,fence=excluded.fence,byte_length=excluded.byte_length`)
              .bind(
                record.collection,
                record.key,
                authority ? record.revision : null,
                authority ? record.fence : null,
                authority ? null : record.fingerprint,
                record.value.byteLength,
                token,
              ),
          );
          if (authority)
            statements.push(
              session
                .prepare(`DELETE FROM sp_d1_chunks WHERE collection=? AND key=? AND ${gate}`)
                .bind(record.collection, record.key, token),
            );
          for (
            let offset = 0, part = 0;
            offset < record.value.byteLength;
            offset += CHUNK_BYTES, part++
          ) {
            statements.push(
              session
                .prepare(
                  `INSERT INTO sp_d1_chunks(collection,key,part,value) SELECT ?,?,?,? WHERE ${gate}`,
                )
                .bind(
                  record.collection,
                  record.key,
                  part,
                  record.value.slice(offset, offset + CHUNK_BYTES).buffer,
                  token,
                ),
            );
          }
          if (aliases) {
            for (const alias of aliases)
              statements.push(
                session
                  .prepare(
                    `INSERT INTO sp_d1_aliases(collection,alias,key) SELECT ?,?,? WHERE ${gate}`,
                  )
                  .bind(record.collection, alias, record.key, token),
              );
            const at = position(record.collection, aliases);
            if (at)
              statements.push(
                session
                  .prepare(
                    `INSERT INTO sp_d1_positions(collection,index_name,scope,position,digits,key) SELECT ?,?,?,?,?,? WHERE ${gate}`,
                  )
                  .bind(
                    record.collection,
                    at.index,
                    at.scope,
                    at.value,
                    at.value.length,
                    record.key,
                    token,
                  ),
              );
          }
        };
        if (mutation.claim) write(mutation.claim, [mutation.claim.key]);
        for (const ensure of plan.inserts)
          write(plan.outcome.ensured[ensure.name]!, [ensure.key, ...(ensure.alternateKeys ?? [])]);
        if (plan.outcome.authority) write(plan.outcome.authority);
        const result = yield* call(() => session.batch(statements));
        if (result[0]!.results.length) return plan.outcome;
        yield* sleep(Math.min(50, 1 + attempt * 2));
      }
      throw new DurableKernelError(
        "durable_kernel_transaction_failed",
        "D1 journal contention exceeded the retry budget",
      );
    },
    *scan(request) {
      validateScan(request);
      const session = database.withSession("first-primary");
      const forward = request.direction === "forward";
      const clauses = ["p.collection=?", "p.index_name=?", "p.scope=?"];
      const args: (string | number)[] = [request.collection, request.index, request.scope];
      if (request.after !== null) {
        clauses.push(`(p.digits,p.position) ${forward ? ">" : "<"} (?,?)`);
        args.push(request.after.length, request.after);
      }
      if (request.through !== undefined) {
        clauses.push(`(p.digits,p.position) ${forward ? "<=" : ">="} (?,?)`);
        args.push(request.through.length, request.through);
      }
      const order = forward ? "ASC" : "DESC";
      const rows = yield* call(() =>
        session
          .prepare(`SELECT p.key,p.position,r.byte_length FROM sp_d1_positions p
        JOIN sp_d1_records r ON r.collection=p.collection AND r.key=p.key WHERE ${clauses.join(" AND ")}
        ORDER BY p.digits ${order},p.position ${order},p.key ${order} LIMIT ?`)
          .bind(...args, request.maxRecords + 1)
          .all<{ key: string; position: string; byte_length: number }>(),
      );
      const page = planScanPage(
        request,
        rows.results.map((row) => ({
          key: row.key,
          position: row.position,
          storedBytes: row.byte_length,
        })),
      );
      const records = [];
      for (const row of page.selected) {
        const result = yield* call(() =>
          readStatement(session, request.collection, row.key, true).all<Row>(),
        );
        const stored = record(result.results) as StoredImmutableRecord | null;
        if (!stored) throw corrupt("Missing indexed journal record");
        if (stored.value.byteLength !== row.storedBytes)
          throw corrupt("Indexed record byte count disagrees with payload");
        records.push({ ...stored, position: row.position, storedBytes: row.storedBytes });
      }
      return { records, nextCursor: page.nextCursor };
    },
    *waitForChange(request) {
      parseCounter(request.afterRevision, "wait revision");
      // This is a wake-up hint, not an authority read. The repository reads before
      // and after waiting. D1 has no native change subscription: do not hide an
      // unbounded billable polling loop inside a single wait. Cross-host changes
      // are observed on the caller's next read after this bounded wait.
      yield* sleep(Math.max(0, request.timeoutMs));
    },
  };
  return kernel;
}
