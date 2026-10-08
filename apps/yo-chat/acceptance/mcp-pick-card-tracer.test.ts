// @vitest-environment node
import { describe, expect, it } from "vitest";
import { run, type Operation } from "effection";
import {
  createDurableToolRegistry,
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import {
  createCapabilityKeyring,
  createWorkflowProgramDriver,
} from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "@sweatpants/journal-authority/testing";
import {
  createDurableEffectRegistry,
  DurableEffectRegistryContext,
} from "@sweatpants/durable-effects/runtime";
import { programDriverSchemaRegistry } from "@sweatpants/durable-chat-runtime/durable-handler";
import { createPickCardMcpTracer, type TracerRequest } from "./fixtures/mcp-pick-card-tracer.ts";
import { pickCard, PickCardContextSchema } from "../src/tools/pick-card/durable.ts";
import { createDrawPickCardsRegistration } from "../src/tools/pick-card/durable-effects.ts";

describe("MCP multi-round-trip pick_card tracer", () => {
  it.each(["accept", "decline", "cancel"] as const)(
    "resumes %s from journal state with a new request ID and deduplicates input",
    async (action) => {
      await run(function* () {
        const authorityOptions = {
          journalId: "mcp-pick-card-tracer",
          journalIncarnation: "1",
          keyring: createCapabilityKeyring("mcp-tracer", [
            { keyId: "test", secret: "mcp-tracer-journal-secret-at-least-32-bytes" },
          ]),
          schemaRegistry: programDriverSchemaRegistry(pickCard.artifacts.catalog),
        };
        let authority = yield* createAuthorityScenarioDriver(authorityOptions);
        const attach = {
          sessionId: "invocation-1",
          taskId: "turn-0/root",
          executionEpoch: 1,
          program: {
            id: pickCard.manifest.programId,
            version: pickCard.manifest.version,
            digest: pickCard.manifest.digest,
          },
          input: { count: 3 },
          route: { driverKind: "local" },
        };
        yield* authority.openTask({
          sessionId: attach.sessionId,
          turnId: "turn-0",
          taskId: attach.taskId,
          manifest: pickCard.manifest,
          input: attach.input,
          executionEpoch: 1,
          attachmentId: "unattached",
          audience: "fixture-program",
        });
        let draws = 0;
        const draw = createDrawPickCardsRegistration();
        const effects = createDurableEffectRegistry([
          {
            ...draw,
            *handler(input, context) {
              draws++;
              return yield* draw.handler(input, context);
            },
          },
        ]);
        let activations = 0;
        const advance = function* (): Operation<AdvancementResult> {
          activations++;
          // Each HTTP round trip gets a fresh generator driver; only the authority survives.
          const drivers = createProgramDriverRegistry([
            ["local", createWorkflowProgramDriver(createDurableToolRegistry([pickCard]))],
          ]);
          return yield* ProgramDriverRegistryContext.with(drivers, () =>
            withProgramDriverTestScope(authority, () =>
              DurableEffectRegistryContext.with(effects, () =>
                driveInstalledTestProgramTree({ attach }),
              ),
            ),
          );
        };
        let now = 1_000;
        const makeTracer = () =>
          createPickCardMcpTracer({
            authority,
            sessionId: attach.sessionId,
            taskId: attach.taskId,
            callerId: "alice",
            arguments: attach.input,
            secret: "mcp-request-state-secret-at-least-32-bytes",
            now: () => now,
            advance,
          });
        const initial: TracerRequest = {
          jsonrpc: "2.0",
          id: "request-1",
          method: "tools/call",
          params: {
            name: "pick_card",
            arguments: { count: 3 },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
            },
          },
        };
        const headers = new Headers({
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "pick_card",
        });
        const parked = yield* makeTracer()(initial, "alice", headers);
        expect(parked).toMatchObject({ id: "request-1", result: { resultType: "input_required" } });
        const requests = parked.result.inputRequests as Record<string, unknown>;
        const [pullId] = Object.keys(requests);
        expect(requests[pullId]).toMatchObject({ method: "elicitation/create" });
        const operation = yield* authority.operationState(attach.sessionId, attach.taskId, pullId);
        if (operation.status !== "found" || operation.descriptor.kind !== "elicit") {
          throw new Error("Missing park");
        }
        const cards = PickCardContextSchema.parse(operation.descriptor.context).cards;
        const continuation = parked.result.requestState as string;
        const retry: TracerRequest = {
          ...initial,
          id: "request-2",
          params: {
            ...initial.params,
            requestState: continuation,
            inputResponses: {
              [pullId]:
                action === "accept"
                  ? { action, content: { picked: cards[0].display } }
                  : { action },
            },
          },
        };

        // Replace the authority object from serialized state as well as replacing the host driver.
        authority = yield* createAuthorityScenarioDriver({
          ...authorityOptions,
          snapshot: JSON.parse(JSON.stringify(authority.exportSnapshot())),
        });
        const replacement = makeTracer();
        const reject = function* (
          request: TracerRequest,
          caller: string,
          message: string,
        ): Operation<void> {
          let caught: unknown;
          try {
            yield* replacement(request, caller, headers);
          } catch (error) {
            caught = error;
          }
          expect(caught).toMatchObject({ message: expect.stringContaining(message) });
        };
        yield* reject(
          {
            ...retry,
            params: {
              ...retry.params,
              _meta: { ...retry.params._meta, "io.modelcontextprotocol/clientCapabilities": {} },
            },
          },
          "alice",
          "form elicitation",
        );
        expect(activations).toBe(1);
        yield* reject(retry, "mallory", "binding mismatch");
        yield* reject(
          { ...retry, params: { ...retry.params, arguments: { count: 4 } } },
          "alice",
          "binding mismatch",
        );
        yield* reject(
          {
            ...retry,
            params: {
              ...retry.params,
              requestState: `${continuation[0] === "A" ? "B" : "A"}${continuation.slice(1)}`,
            },
          },
          "alice",
          "signature",
        );
        now = 61_000;
        yield* reject(retry, "alice", "Expired");
        now = 2_000;
        expect(draws).toBe(1);
        const completed = yield* replacement(retry, "alice", headers);
        expect(completed).toMatchObject({ id: "request-2", result: { resultType: "complete" } });
        expect(JSON.stringify(completed.result)).toContain(
          action === "accept" ? cards[0].display : "No card was selected.",
        );
        expect(draws).toBe(1);
        expect(activations).toBe(2);
        const duplicate = yield* replacement({ ...retry, id: "request-3" }, "alice", headers);
        expect(duplicate.result).toEqual(completed.result);
        expect(duplicate.id).toBe("request-3");
        expect(activations).toBe(2);
        yield* reject(
          {
            ...retry,
            params: {
              ...retry.params,
              inputResponses: {
                [pullId]: {
                  action: "accept",
                  content: { picked: cards[1].display },
                },
              },
            },
          },
          "alice",
          "Conflicting duplicate",
        );
        expect(
          authority
            .readJournal(attach.sessionId)
            .filter(
              (record) =>
                record.payload.type === "PullResolved" && record.payload.pullId === pullId,
            ),
        ).toHaveLength(1);
      });
    },
  );
});
