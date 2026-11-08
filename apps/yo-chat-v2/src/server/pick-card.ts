import type { Operation } from "@standard-durability/core";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery, type ResolutionGrant } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  installEffectAnswers,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import { createToolAcquisition } from "@sweatpan.ts/tools";
import { z } from "zod";
import { cardId, cardQuestion, chooseCard, pickCard } from "../tools/pick-card.ts";

type Result = ReturnType<typeof pickCard.body> extends Operation<infer R, unknown> ? R : never;

/** One invocation bound to a caller-owned connection. No background work. */
export function createPickCardSession<Y>(runtime: Runtime<Y>, db: DatabaseSync, execution: string) {
  const journal = createSqliteJournalStore<Result, CapabilityRequest, unknown, string, unknown, Y>({
    connection: createNodeSqliteConnection(db),
    id: `pick-card:${execution}`,
    program: pickCard.id,
    equals: isDeepStrictEqual,
    serialization: {
      *resolve() {
        return v8Serializer;
      },
    },
  }).open();
  const effects = createEffectCapabilities(runtime, "pick-card");
  const acquisition = createToolAcquisition(runtime, effects, pickCard, "pick-card:acquisition");
  const recovery = createRecovery(runtime.composition, {
    name: "pick-card:recovery",
    program: pickCard.id,
    matches: isDeepStrictEqual,
    acquire: () => acquisition.operations.acquire({}),
  });
  const host = createHosting(runtime.composition, {
    name: "pick-card:host",
    journal,
    recovery: recovery.operations,
    interactions: journal.interactions,
    attempts: journal.attempts,
    handle: acquisition.handle,
  });
  function* advance() {
    yield* host.around(acquisition.admission);
    yield* host.around({
      *deliveryMode([request]) {
        if (request.effect !== chooseCard.id) {
          throw new Error("Unexpected pick_card effect");
        }
        return "wait" as const;
      },
    });
    yield* installGuestRetention(runtime.composition, host, recovery, journal);
    yield* host.operations.run();
  }
  function* read() {
    const snapshot = yield* journal.read();
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
    read,
    *start() {
      // Repeating the same execution ID repairs interrupted admission/advancement.
      yield* journal.admit(pickCard.id, {});
      yield* advance();
      return yield* read();
    },
    *answer(grant: ResolutionGrant, card: z.infer<typeof cardId>) {
      const ingress = yield* installEffectAnswers(
        host,
        effects.grant(pickCard.elicits),
        journal.interactions,
      );
      const accepted = yield* ingress.answer(grant, { ok: true, value: card });
      // Acceptance and advancement are separate. Identical retry recovers the receipt
      // and finishes replay if the previous request ended between these two steps.
      yield* advance();
      const view = yield* read();
      return { receipt: accepted.entry.receipt, duplicate: accepted.duplicate, view };
    },
  };
}
