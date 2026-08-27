import { run, scoped } from "effection";
import { describe, expect, it } from "vitest";
import type { AttachProgramRequest, DurableProgramManifest } from "@sweatpants/durable-execution";
import { stableProgramAttachmentId } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import { canonicalSnapshot } from "@sweatpants/foundation";
import { createAuthorityScenarioDriver, withProgramDriverTestScope } from "../testing.ts";
import { pullOperation, type Workflow } from "../workflow/runtime.ts";
import { driveActivation } from "../workflow/host-drive.ts";
import { anyGuard, createSchemaFixture } from "../schema-fixtures.ts";
import { createCapabilityKeyring } from "../capabilities.ts";
import { createDurableSchemaRegistry } from "../schema-registry.ts";

const programInput = createSchemaFixture(
  "fixture.foreign/input",
  "program_input",
  { type: "null" },
  () => undefined,
);
const programOutput = createSchemaFixture(
  "fixture.foreign/output",
  "program_output",
  {
    type: "object",
    required: ["forecast"],
    properties: { forecast: { type: "string" } },
    additionalProperties: false,
  },
  anyGuard,
);
const schemaRegistry = () => createDurableSchemaRegistry([programInput.entry, programOutput.entry]);

const keyring = createCapabilityKeyring("foreign-authority", [
  { keyId: "foreign-key", secret: "foreign-key-secret-is-32-bytes-ok" },
]);

const manifest: DurableProgramManifest = {
  programId: "fixture.foreign",
  version: "1.0.0",
  digest: "9".repeat(64),
  inputSchema: programInput.descriptor,
  outputSchema: programOutput.descriptor,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
};

function attach(sessionId: string): AttachProgramRequest {
  return {
    sessionId,
    taskId: "turn-0/root",
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: null,
    route: { driverKind: "program" },
    executionEpoch: 1,
  };
}

function makeAuthority(journalId: string) {
  return createAuthorityScenarioDriver({
    journalId,
    journalIncarnation: "incarnation-1",
    keyring,
    now: () => 1_000,
    schemaRegistry: schemaRegistry(),
  });
}

function weatherWorkflow(): Workflow<Json> {
  return function* (): Workflow<Json> {
    const forecast = yield* pullOperation({
      kind: "ephemeral",
      driver: "tool-session",
      tool: "weather",
      input: { city: " oslo" },
      durability: "ephemeral_handle",
    });
    return { forecast: String((forecast as { sky?: string }).sky ?? forecast) };
  };
}

describe("workflow runtime foreign boundaries", () => {
  it("parks on a ephemeral call and settles through session resolution", async () => {
    const sessionId = "foreign-ok";
    const authority = makeAuthority("journal-foreign-ok");
    const request = attach(sessionId);

    const outcome = await run(function* () {
      return yield* withProgramDriverTestScope(authority, function* () {
        const opened = (yield* authority.openTask({
          sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: null,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        })) as unknown as { programCapability: string };

        // Activation 1: parks on the live foreign reference.
        const parked = yield* driveActivation({
          attach: request,
          authority,
          programCapability: opened.programCapability,
          workflow: weatherWorkflow(),
        });
        if (parked.state !== "parked" || parked.reason !== "ephemeral") {
          throw new Error(
            `expected parked ephemeral, got ${parked.state}/${"reason" in parked ? parked.reason : "?"}`,
          );
        }

        // Session settles against its live reference.
        const pending = authority
          .readJournal(sessionId)
          .find(
            (e): e is Extract<typeof e, { payload: { type: "PullRequested" } }> =>
              e.payload.type === "PullRequested" && e.payload.descriptor.kind === "ephemeral",
          );
        if (!pending || pending.payload.type !== "PullRequested") {
          throw new Error("ephemeral pull missing");
        }
        if (pending.payload.descriptor.kind !== "ephemeral") return;
        const resolved = yield* authority.resolve({
          capability: authority.resolutionCapability(
            sessionId,
            request.taskId,
            pending.payload.pullId,
          ),
          audience: "ephemeral:tool-session",
          outcome: { status: "ok", value: { sky: "sunny" } },
        });
        if (resolved.status === "rejected") throw new Error(resolved.code);

        // Restore replays the settled call and completes.
        const bound = yield* authority.bindProgramAttachment(
          sessionId,
          request.taskId,
          stableProgramAttachmentId(request) + "-2",
          1,
        );
        const settled = yield* driveActivation({
          attach: request,
          authority,
          programCapability: bound.programCapability,
          workflow: weatherWorkflow(),
        });
        return settled;
      });
    });

    expect(outcome).toEqual({ state: "completed", value: { forecast: "sunny" } });
  });

  it("journals a lost-reference resolution as a program failure", async () => {
    const sessionId = "foreign-lost";
    const authority = makeAuthority("journal-foreign-lost");
    const request = attach(sessionId);

    const outcome = await run(function* () {
      return yield* withProgramDriverTestScope(authority, function* () {
        const opened = (yield* authority.openTask({
          sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: null,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        })) as unknown as { programCapability: string };

        const parked = yield* driveActivation({
          attach: request,
          authority,
          programCapability: opened.programCapability,
          workflow: weatherWorkflow(),
        });
        if (parked.state !== "parked") throw new Error(`expected parked, got ${parked.state}`);

        // Reference died while the program stayed parked: the session
        // journals the error resolution.
        const pending = authority
          .readJournal(sessionId)
          .find(
            (e): e is Extract<typeof e, { payload: { type: "PullRequested" } }> =>
              e.payload.type === "PullRequested" && e.payload.descriptor.kind === "ephemeral",
          );
        if (!pending || pending.payload.type !== "PullRequested") throw new Error("no pull");
        const resolved = yield* authority.resolve({
          capability: authority.resolutionCapability(
            sessionId,
            request.taskId,
            pending.payload.pullId,
          ),
          audience: "ephemeral:tool-session",
          outcome: {
            status: "error",
            error: { code: "foreign_reference_lost", message: "live reference gone" },
          },
        });
        if (resolved.status === "rejected") throw new Error(resolved.code);

        const bound = yield* authority.bindProgramAttachment(
          sessionId,
          request.taskId,
          stableProgramAttachmentId(request) + "-2",
          1,
        );
        return yield* driveActivation({
          attach: request,
          authority,
          programCapability: bound.programCapability,
          workflow: weatherWorkflow(),
        });
      });
    });

    expect(outcome).toEqual({
      state: "failed",
      error: { code: "foreign_reference_lost", message: "live reference gone" },
    });
  });

  it("rejects non-ephemeral foreign durabilities at reserve", async () => {
    const sessionId = "foreign-durability";
    const authority = makeAuthority("journal-foreign-durability");
    const request = attach(sessionId);

    await run(function* () {
      yield* scoped(function* () {
        const opened = (yield* authority.openTask({
          sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: null,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        })) as unknown as { programCapability: string };

        let threw: unknown;
        try {
          yield* driveActivation({
            attach: request,
            authority,
            programCapability: opened.programCapability,
            workflow: function* (): Workflow<Json> {
              yield* pullOperation({
                kind: "ephemeral",
                driver: "mcp",
                tool: "remote",
                input: {},
                durability: "resumable_handle",
              });
              return {};
            },
          });
        } catch (error) {
          threw = error;
        }
        expect(threw).toMatchObject({ code: "invalid_descriptor" });
      });
    });
  });

  it("records the foreign request canonically in the journal", async () => {
    const sessionId = "foreign-journal";
    const authority = makeAuthority("journal-foreign-journal");
    const request = attach(sessionId);

    await run(function* () {
      yield* withProgramDriverTestScope(authority, function* () {
        const opened = (yield* authority.openTask({
          sessionId,
          turnId: "turn-0",
          taskId: request.taskId,
          manifest,
          input: null,
          executionEpoch: 1,
          attachmentId: stableProgramAttachmentId(request),
          audience: "program-host",
        })) as unknown as { programCapability: string };

        yield* driveActivation({
          attach: request,
          authority,
          programCapability: opened.programCapability,
          workflow: weatherWorkflow(),
        });

        const pull = authority
          .readJournal(sessionId)
          .find(
            (e): e is Extract<typeof e, { payload: { type: "PullRequested" } }> =>
              e.payload.type === "PullRequested",
          );
        expect(pull?.payload.type).toBe("PullRequested");
        if (pull?.payload.type === "PullRequested") {
          expect(canonicalSnapshot(pull.payload.descriptor).value).toMatchObject({
            kind: "ephemeral",
            driver: "tool-session",
            tool: "weather",
          });
          void (null as unknown as Json);
        }
      });
    });
  });
});
