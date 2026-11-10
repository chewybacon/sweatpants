import { z } from "zod";
import { installCardDeck } from "./card-capabilities.ts";
import type { Operation } from "@standard-durability/core";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import type { ToolApplicationOptions } from "@sweatpan.ts/tools";
import { pickCard } from "../tools/pick-card.ts";

type Result = ReturnType<typeof pickCard.body> extends Operation<infer R, unknown> ? R : never;

/** Local application policy and storage. Native task ownership stays with the caller. */
export function cardApplicationOptions<Y>(runtime: Runtime<Y>, openDatabase: () => DatabaseSync) {
  return {
    name: "cards",
    matches: isDeepStrictEqual,
    configure: installCardDeck,
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
  } satisfies ToolApplicationOptions<
    z.input<typeof pickCard.context>,
    z.output<typeof pickCard.context>,
    Result,
    Y
  >;
}
