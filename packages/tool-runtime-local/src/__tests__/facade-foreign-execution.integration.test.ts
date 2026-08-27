import { foreignToolSchemaEntries } from "@sweatpants/tool-session/foreign";
import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import type { Json } from "@sweatpants/foundation";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import {
  createPinnedDurableProgram,
  defineDurableProgramManifest,
} from "@sweatpants/durable-execution";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { anyGuard, createSchemaFixture } from "@sweatpants/journal-authority/testing";
import {
  createDurableToolSessionFacade,
  createForeignPullResolver,
  createInMemoryDurableToolFacadeStateStore,
  createLocalToolInvocationRuntime,
} from "../index.ts";

/**
 * End-to-end foreign execution through the facade's workflow runtime,
 * driven via the callable-tool surface: the parent proposes a foreign pull,
 * the facade's executor runs the live `createTool` across its sample and
 * elicit backchannels (answered by pure relays), resolves the pull, and the
 * parent completes.
 */
// KNOWN GAP (tied to the deferred sampling-park decision): the invocation
// host's crank semantics currently re-raise the sampling ask once after the
// resume is delivered, so the relay observes two distinct requestIds for one
// authored ctx.sample call. Everything else in the flow (park, settlement,
// replay) is verified by the kernel-level foreign proofs. Skipped until the
// sampling-park semantic decision lands.
describe("facade workflow runtime foreign execution", () => {
  it("executes a backchannel-heavy foreign tool across one parked pull", async () => {
    let sampledPrompts = 0;
    const elicitedCities: unknown[] = [];

    const weather = createTool("wf_weather")
      .description("Forecasts with sampling and approval")
      .parameters(z.object({ city: z.string() }))
      .elicits({
        approve: {
          response: z.object({ go: z.boolean() }),
          context: z.object({ city: z.string() }),
        },
      })
      .samples()
      .execute(function* ({ city }, ctx) {
        const sample = yield* ctx.sample({ prompt: `Narrate the forecast for ${city}` });
        const choice = yield* ctx.elicit("approve", {
          message: sample.text,
          context: { city },
        });
        if (choice.action !== "accept") {
          return { forecast: "declined" };
        }
        return { forecast: `${city}: sunny (approved)` };
      });

    const parentInput = createSchemaFixture(
      "foreign-facade/input",
      "program_input",
      { type: "null" },
      anyGuard,
    );
    const parentOutput = createSchemaFixture(
      "foreign-facade/output",
      "program_output",
      {
        type: "object",
        required: ["report"],
        properties: { report: { type: "string" } },
        additionalProperties: false,
      },
      anyGuard,
    );
    const parentManifest = defineDurableProgramManifest<null, { report: string }>({
      programId: "foreign-facade/parent",
      version: "1.0.0",
      digest: "f".repeat(64),
      inputSchema: parentInput.descriptor,
      outputSchema: parentOutput.descriptor,
      elicits: {},
      effects: {},
      capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
    });
    const parentTool = createPinnedDurableProgram(parentManifest, function* (_input, context) {
      const result = (yield* context.pull({
        kind: "ephemeral",
        driver: "tool-session",
        tool: "wf_weather",
        input: { city: "oslo" },
        durability: "ephemeral_handle",
      })) as { forecast: string };
      return { report: result.forecast };
    });

    const stateStore = createInMemoryDurableToolFacadeStateStore();
    const keyring = createCapabilityKeyring("foreign-facade", [
      { keyId: "active", secret: "foreign-facade-secret-is-32-bytes" },
    ]);
    const facade = createDurableToolSessionFacade({
      tool: parentTool,
      stateStore,
      keyring,
      name: "foreign_facade_tool",
      schemaRegistry: createDurableSchemaRegistry([
        ...foreignToolSchemaEntries(),
        parentInput.entry,
        parentOutput.entry,
      ]),
      pullResolvers: [
        createForeignPullResolver({
          tools: new Map([["wf_weather", weather]]),
          asks: {
            sample: function* (ask: {
              requestId: string;
              text?: string;
              systemPrompt?: string;
            }): Operation<{ text: string }> {
              sampledPrompts += 1;
              void ask.systemPrompt;
              return { text: `${ask.text ?? ""} [narrated]` };
            },
            elicit: function* (ask: {
              message: string;
              context?: Json;
            }): Operation<{ action: "accept"; content: { go: boolean } }> {
              elicitedCities.push(ask.context);
              void ask.message;
              return { action: "accept", content: { go: true } };
            },
          },
        }),
      ],
    });

    // Drive the facade through its callable surface with a rejecting outer
    // context: nothing should reach it — foreign asks ride the relays.
    const outcome = await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const callableFacade = facade as unknown as (
        context: never,
      ) => Operation<(input: { invocationId: string; input: null }) => Operation<unknown>>;
      const invoke = yield* callableFacade({
        sample() {
          throw new Error("outer sample must not be reached");
        },
        elicit() {
          throw new Error("outer elicit must not be reached");
        },
      } as never);
      return yield* invoke({ invocationId: "foreign-facade-inv-1", input: null });
    });

    expect(outcome).toEqual({ report: "oslo: sunny (approved)" });
    expect(sampledPrompts).toBe(1);
    expect(elicitedCities).toEqual([{ city: "oslo" }]);
  });
});
