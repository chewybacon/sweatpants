/**
 * Provider prompt-prefix stability.
 *
 * LLM prompt caching keys on exact byte prefixes. Exchange ids minted by the
 * tool runtime become provider-visible bytes: a structured sample's exchange
 * carries an assistant tool-call part and a tool result message whose ids are
 * embedded in any later prompt that includes that exchange.
 *
 * The invariant pinned here: identity that reaches provider bytes is a pure
 * function of durable identity (session, task, sequence) — never wall-clock,
 * randomness, or arrival order. Two executions of the same logical invocation
 * must produce byte-identical provider contexts, or every retry and replay
 * invalidates the provider cache.
 */
import {
  ProgramDriverRegistryContext,
  ProgramRuntime,
  createDurableToolRegistry,
  createProgramDriverRegistry,
  type AttachProgramRequest,
  type ForeignToolRequest,
  type ProgramRunResult,
} from "@sweatpants/durable-execution";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool, type RuntimeTool } from "@sweatpants/agent-sdk";
import type { ChatMessage } from "@sweatpants/chat-contract";
import { canonicalSnapshot } from "@sweatpants/foundation";
import {
  withJournalAuthority,
  createCapabilityKeyring,
  createInMemoryDurableJournalAuthority,
} from "@sweatpants/journal-authority";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import {
  FOREIGN_TOOL_ADAPTER_MANIFEST,
  foreignToolAdapter,
  foreignToolSchemaEntries,
} from "@sweatpants/tool-session/foreign";

import {
  createLocalToolInvocationRuntime,
  createLocalDurableProgramDriver,
  createToolInvocationForeignEffectRegistrations,
} from "../index.ts";
import { withModelSampleTestBoundary } from "./model-sample-test-boundary.ts";

const label = z.object({ label: z.string() });

/**
 * Two structured samples where the second prompt explicitly carries the first
 * exchange — the pattern any multi-sample tool uses to keep model context.
 * The first exchange's tool-call id therefore lands in the second sample's
 * provider-visible bytes.
 */
const probeTool = createTool("prompt_stability_probe")
  .description("Two structured samples; the second carries the first exchange")
  .parameters(z.object({ topic: z.string() }))
  .samples()
  .execute(function* ({ topic }, context) {
    const first = yield* context.sampleSchema({
      prompt: `Classify ${topic}`,
      schema: label,
    });
    const refine: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: "Refine the classification" }],
    };
    const second = yield* context.sampleSchema({
      messages: [...first.exchange.messages, refine],
      schema: label,
    });
    return { labels: [first.parsed?.label ?? null, second.parsed?.label ?? null] };
  });

interface ExecutionCapture {
  readonly result: ProgramRunResult;
  /** Canonical bytes of each model sample's provider-visible context. */
  readonly contexts: string[];
}

function executeProbe(sessionId: string): Promise<ExecutionCapture> {
  const request: ForeignToolRequest = {
    driver: "tool-session",
    tool: probeTool.name,
    input: { topic: "stability" },
    durability: "ephemeral_handle",
  };
  const taskId = "turn-0/root";
  const attach: AttachProgramRequest = {
    sessionId,
    taskId,
    program: {
      id: FOREIGN_TOOL_ADAPTER_MANIFEST.programId,
      version: FOREIGN_TOOL_ADAPTER_MANIFEST.version,
      digest: FOREIGN_TOOL_ADAPTER_MANIFEST.digest,
    },
    input: request,
    route: { driverKind: "program" },
    executionEpoch: 1,
  };
  const keyring = createCapabilityKeyring("prompt-stability", [
    { keyId: "active", secret: "prompt-stability-secret-32-bytes!" },
  ]);
  const authority = createInMemoryDurableJournalAuthority({
    journalId: "prompt-stability",
    journalIncarnation: "1",
    keyring,
    schemaRegistry: createDurableSchemaRegistry(foreignToolSchemaEntries()),
  });
  const drivers = createProgramDriverRegistry([
    ["program", createLocalDurableProgramDriver(createDurableToolRegistry([foreignToolAdapter]))],
  ]);

  const contexts: string[] = [];
  return run(function* () {
    yield* createLocalToolInvocationRuntime({});
    const effects = createDurableEffectRegistry([
      ...createToolInvocationForeignEffectRegistrations({
        tools: new Map<string, RuntimeTool>([[probeTool.name, probeTool]]),
      }),
      foreignToolAdapter.modelSampleRegistration(function* (sampleRequest) {
        contexts.push(canonicalSnapshot(sampleRequest.invocation.context).canonical);
        return {
          message: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: `{"label":"answer-${contexts.length}"}` }],
            },
            source: null,
            usage: null,
            stopReason: null,
            responseId: null,
            errorMessage: null,
          },
          output: { type: "message" },
        };
      }),
    ]);
    yield* authority.openTask({
      sessionId,
      turnId: "turn-0",
      taskId,
      manifest: FOREIGN_TOOL_ADAPTER_MANIFEST,
      input: request,
      executionEpoch: 1,
      attachmentId: "unattached-adapter",
      audience: "program-runtime",
    });
    const result: ProgramRunResult = yield* ProgramDriverRegistryContext.with(
      drivers,
      function* () {
        return yield* withJournalAuthority(authority, function* () {
          return yield* DurableEffectRegistryContext.with(effects, function* () {
            return yield* withModelSampleTestBoundary(() =>
              ProgramRuntime.operations.run({ attach, executeHostEffects: true }),
            );
          });
        });
      },
    );
    return { result, contexts };
  });
}

describe("provider prompt-prefix stability", () => {
  it("produces byte-identical provider contexts when the same logical invocation executes twice", async () => {
    const first = await executeProbe("stability-session");
    const second = await executeProbe("stability-session");

    expect(first.result).toMatchObject({ state: "completed" });
    expect(first.contexts).toHaveLength(2);

    // The second sample's prompt must carry the first exchange's tool-call id.
    expect(first.contexts[1]).toMatch(/schema_/);

    // Same durable identity, re-executed → byte-identical provider bytes.
    // Wall-clock or random exchange ids fail here, and every such failure is
    // a provider cache invalidation in production.
    expect(second.contexts).toEqual(first.contexts);
  });

  it("changes provider bytes when the durable session identity changes", async () => {
    // Teeth for the equality assertion above: session identity demonstrably
    // flows into provider bytes, so byte-equality is not vacuous. This also
    // documents the coupling — renaming session-id derivation is a
    // provider-cache-invalidating change and must be treated as one.
    const first = await executeProbe("stability-session");
    const other = await executeProbe("different-session");

    expect(other.contexts).toHaveLength(2);
    expect(other.contexts[1]).not.toEqual(first.contexts[1]);
  });
});
