import { run } from "effection";
import { objectEnsure } from "./domain-records.ts";
import { durableKey } from "@sweatpants/durable-storage-kernel";
import { createD1DurableKernel, initializeD1Storage } from "../../index.ts";
import type { D1Database } from "@cloudflare/workers-types";
export default {
  async fetch(request: Request, env: { JOURNAL: D1Database }) {
    await initializeD1Storage(env.JOURNAL);
    const kernel = createD1DurableKernel(env.JOURNAL);
    if (request.method === "POST") {
      await run(() =>
        kernel.apply({
          ensures: [objectEnsure("restart", [4, 2])],
        }),
      );
    }
    const record = await run(() =>
      kernel.readImmutable("execution-objects", durableKey("restart")),
    );
    return Response.json(record ? (record.value as { body: unknown }).body : null);
  },
};
