import type { Operation } from "@standard-durability/core";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ResolutionGrant } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import { createToolApplication } from "@sweatpan.ts/tools";
import { z } from "zod";
import { cardId, cardQuestion, pickCard } from "../tools/pick-card.ts";

type Result = ReturnType<typeof pickCard.body> extends Operation<infer R, unknown> ? R : never;

/** Local application policy and storage. Native task ownership stays with the caller. */
export function createCardApplication<Y>(runtime: Runtime<Y>, openDatabase: () => DatabaseSync) {
  const tools = createToolApplication(runtime, pickCard, {
    name: "cards",
    matches: isDeepStrictEqual,
    *open(execution) {
      const db = openDatabase();
      yield* runtime.composition.ensure(function* () {
        db.close();
      });
      return createSqliteJournalStore<Result, CapabilityRequest, unknown, string, unknown, Y>({
        connection: createNodeSqliteConnection(db),
        id: execution,
        program: pickCard.id,
        equals: isDeepStrictEqual,
        serialization: {
          *resolve() {
            return v8Serializer;
          },
        },
      }).open();
    },
  });
  function* read(execution: string) {
    const snapshot = yield* tools.operations.read(`pick-card:${execution}`);
    if (!snapshot.admission) {
      return undefined;
    }
    if (snapshot.status === "completed") {
      return { execution, status: "completed" as const, value: snapshot.value };
    }
    if (snapshot.status === "cancelled") {
      return { execution, status: "cancelled" as const, reason: snapshot.reason };
    }
    if (snapshot.pending && snapshot.interaction?.state === "waiting") {
      return {
        execution,
        status: "waiting" as const,
        question: cardQuestion.parse(snapshot.pending.request.input),
        grant: snapshot.interaction.grant,
      };
    }
    return { execution, status: "running" as const };
  }
  return {
    tools,
    read,
    *start(execution: string) {
      yield* tools.operations.start(`pick-card:${execution}`, {});
      return yield* read(execution);
    },
    *answer(execution: string, grant: ResolutionGrant, card: z.infer<typeof cardId>) {
      const accepted = yield* tools.operations.answer(`pick-card:${execution}`, grant, {
        ok: true,
        value: card,
      });
      // Acceptance and advancement remain separate. An identical retry recovers the
      // receipt and repairs an interrupted advance without repeating accepted work.
      yield* tools.operations.run(`pick-card:${execution}`);
      const view = yield* read(execution);
      return { receipt: accepted.entry.receipt, duplicate: accepted.duplicate, view };
    },
  };
}
