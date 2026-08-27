import { createWorkflowProgramDriver } from "@sweatpants/journal-authority";
import { foreignToolSchemaEntries } from "@sweatpants/tool-session/foreign";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertJson } from "@sweatpants/foundation";
import { createTool, type RuntimeTool } from "@sweatpants/agent-sdk";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "@sweatpants/journal-authority/testing";
import {
  FOREIGN_TOOL_ADAPTER_MANIFEST,
  foreignToolAdapter,
} from "@sweatpants/tool-session/foreign";
import {
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  defineDurableProgramManifest,
  type AttachProgramRequest,
  type EphemeralToolRequest,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
} from "@sweatpants/durable-effects/runtime";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";
import { anyGuard, createSchemaFixture } from "@sweatpants/journal-authority/testing";
import {
  createDurableToolSessionFacade,
  createInMemoryDurableToolFacadeStateStore,
  createLocalToolInvocationRuntime,
  createToolInvocationForeignEffectRegistrations,
} from "../index.ts";

/**
 * Authored parent invoking an authored child through the facade's workflow
 * runtime: the child composition must happen host-side (ensure-child, nested
 * activation, replay) while the outer adapter stays on whatever driver the
 * session composes — proving mixed-driver coexistence in one process.
 */
describe("facade workflow runtime child composition", () => {
  it("composes authored child invocations on the workflow runtime", async () => {
    const childInput = createSchemaFixture(
      "compose/child-input",
      "program_input",
      { type: "null" },
      anyGuard,
    );
    const childOutput = createSchemaFixture(
      "compose/child-output",
      "program_output",
      {
        type: "object",
        required: ["echo"],
        properties: { echo: { type: "string" } },
        additionalProperties: false,
      },
      anyGuard,
    );
    const parentInput = createSchemaFixture(
      "compose/parent-input",
      "program_input",
      { type: "null" },
      anyGuard,
    );
    const parentOutput = createSchemaFixture(
      "compose/parent-output",
      "program_output",
      {
        type: "object",
        required: ["answers"],
        properties: { answers: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
      anyGuard,
    );
    const childManifest = defineDurableProgramManifest<null, { echo: string }>({
      programId: "compose/child",
      version: "1.0.0",
      digest: "c".repeat(64),
      inputSchema: childInput.descriptor,
      outputSchema: childOutput.descriptor,
      elicits: {},
      effects: {},
      capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
    });
    const parentManifest = defineDurableProgramManifest<null, { answers: string[] }>({
      programId: "compose/parent",
      version: "1.0.0",
      digest: "d".repeat(64),
      inputSchema: parentInput.descriptor,
      outputSchema: parentOutput.descriptor,
      elicits: {},
      effects: {},
      capabilities: { durableEmissions: false, structuredChildren: true, replay: "strict" },
    });
    const childTool = createPinnedDurableProgram(childManifest, function* () {
      return { echo: "child-says" };
    });
    const parentTool = createPinnedDurableProgram(parentManifest, function* (_input, context) {
      const childResult = (yield* context.pull(
        assertJson({
          kind: "invoke",
          child: {
            id: childManifest.programId,
            version: childManifest.version,
            digest: childManifest.digest,
            input: null,
          },
        }),
      )) as { echo: string };
      return { answers: [childResult.echo] };
    });

    const stateStore = createInMemoryDurableToolFacadeStateStore();
    const keyring = createCapabilityKeyring("compose-inner", [
      { keyId: "active", secret: "compose-inner-secret-is-32-bytes" },
    ]);
    const facade = createDurableToolSessionFacade({
      tool: parentTool,
      stateStore,
      keyring,
      name: "compose_durable_tool",
      children: createDurableToolRegistry([childTool]),
      schemaRegistry: createDurableSchemaRegistry([
        ...foreignToolSchemaEntries(),
        childInput.entry,
        childOutput.entry,
        parentInput.entry,
        parentOutput.entry,
      ]),
    });
    const request: EphemeralToolRequest = {
      driver: "tool-session",
      tool: facade.name,
      input: null,
      durability: "ephemeral_handle",
    };
    const outerKeyring = createCapabilityKeyring("compose-outer", [
      { keyId: "active", secret: "compose-outer-secret-is-32-bytes" },
    ]);
    const authority = createAuthorityScenarioDriver({
      journalId: "compose-outer",
      journalIncarnation: "1",
      keyring: outerKeyring,
      schemaRegistry: createDurableSchemaRegistry([
        ...foreignToolSchemaEntries(),
        parentInput.entry,
        parentOutput.entry,
      ]),
    });
    const sessionId = "compose-session";
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

    await run(function* () {
      yield* createLocalToolInvocationRuntime({});
      const effects = createDurableEffectRegistry([
        ...createToolInvocationForeignEffectRegistrations({
          tools: new Map<string, RuntimeTool>([[facade.name, facade as unknown as RuntimeTool]]),
        }),
      ]);
      yield* authority.openTask({
        sessionId,
        turnId: "turn-0",
        taskId,
        manifest: FOREIGN_TOOL_ADAPTER_MANIFEST,
        input: request,
        executionEpoch: 1,
        attachmentId: "unattached-compose-adapter",
        audience: "workflow-host",
      });

      // One outer activation completes end-to-end: the facade composes its
      // authored child while the outer adapter runs through the ProgramDriver
      // workflow transport in the same process.
      const outcome: AdvancementResult = yield* runOuter(attach, authority, effects);
      expect(outcome).toEqual({ state: "completed", value: { answers: ["child-says"] } });
    });
  });
});

function runOuter(
  attach: AttachProgramRequest,
  authority: ReturnType<typeof createAuthorityScenarioDriver>,
  effects: ReturnType<typeof createDurableEffectRegistry>,
): Operation<AdvancementResult> {
  const adapterTools = createDurableToolRegistry([foreignToolAdapter]);
  return ProgramDriverRegistryContext.with(
    createProgramDriverRegistry([["program", createWorkflowProgramDriver(adapterTools)]]),
    function* () {
      return yield* withProgramDriverTestScope(authority, function* () {
        return yield* DurableEffectRegistryContext.with(effects, function* () {
          return yield* driveInstalledTestProgramTree({ attach });
        });
      });
    },
  );
}
