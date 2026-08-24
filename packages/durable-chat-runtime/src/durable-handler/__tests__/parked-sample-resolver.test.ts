import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { CrankError } from "@sweatpants/durable-execution";
import type { ModelSamplingService } from "@sweatpants/model-sampling";
import type { ModelContext } from "@sweatpants/model-provider";

import { createParkedSamplePullResolver } from "../parked-sample-resolver.ts";

const placement = {
  program: { id: "chat.root", version: "1", digest: "a".repeat(64) },
  route: { kind: "local" },
  driverKind: "workflow",
  executionEpoch: 1,
};

function* identity(): Operation<{ id: string; incarnation: string }> {
  return { id: "journal-1", incarnation: "inc-1" };
}

const sourceResolver = function* (): Operation<ModelContext> {
  return { messages: [], tools: [] };
};

function recordingService(
  samples: Array<{ placement: unknown; wireRequest: unknown; sessionId: string }>,
): ModelSamplingService {
  return {
    *sample(request, attempt) {
      samples.push({
        placement: attempt.placement,
        wireRequest: request,
        sessionId: attempt.sessionId,
      });
      return { status: "cancelled" as const };
    },
  };
}

describe("parked sample pull resolver", () => {
  it("settles with settle-site placement evidence and never host state", async () => {
    const samples: Array<{ placement: unknown; wireRequest: unknown; sessionId: string }> = [];
    const resolver = createParkedSamplePullResolver({
      service: recordingService(samples),
      journalIdentity: identity,
      sourceResolver,
    });

    const outcome = await run(function* () {
      return yield* resolver.perform(
        {
          sessionId: "session-1",
          taskId: "turn-0/root",
          pullId: "pull-1",
          placement,
        },
        {
          kind: "sample",
          input: {
            invocation: {
              context: {
                type: "object",
                object: { objectId: "ctx-1" },
                digest: "d".repeat(64),
              },
            },
            tools: { type: "none" },
            response: { type: "message" },
          },
        },
      );
    });

    expect(resolver.audience({ kind: "sample" })).toBe("model-runtime");
    expect(outcome).toEqual({ status: "cancelled" });
    expect(samples).toHaveLength(1);
    expect(samples[0].placement).toEqual({
      journal: { id: "journal-1", incarnation: "inc-1" },
      program: placement.program,
      route: placement.route,
      driverKind: "workflow",
    });
  });

  it("rejects descriptors of another kind", async () => {
    const resolver = createParkedSamplePullResolver({
      service: recordingService([]),
      journalIdentity: identity,
      sourceResolver,
    });

    const error = await run(function* () {
      try {
        yield* resolver.perform(
          { sessionId: "s", taskId: "t", pullId: "p", placement },
          { kind: "elicit" },
        );
        return null;
      } catch (caught) {
        return caught;
      }
    });

    expect(error).toBeInstanceOf(CrankError);
    expect((error as CrankError).code).toBe("invalid_descriptor");
  });
});
