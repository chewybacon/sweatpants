import { run, type Operation } from "effection";
import { createApi } from "effection/experimental";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createDurableProgramContext,
  createDurableToolRegistry,
  createLocalProgramDriver,
  sha256,
  type Json,
  type ProgramResume,
  type ProgramStepProposal,
} from "@sweatpants/session-contract";

import { createDurableTool } from "../durable-create.ts";
import { defineDurableContextExtension } from "../durable-context-extension.ts";
import { defineEffect } from "../durable-effect.ts";

interface DataApi {
  readValue(input: { key: string }): Operation<{ value: string; revision: string }>;
  writeValue(input: {
    key: string;
    value: string;
    expectedRevision: string;
  }): Operation<{ revision: string }>;
}

const Data = createApi<DataApi>("acceptance:data", {
  *readValue() {
    throw new Error("data provider unavailable");
  },
  *writeValue() {
    throw new Error("data provider unavailable");
  },
});

const data = defineDurableContextExtension({
  name: "data",
  api: Data.operations,
  client({ api, self }) {
    return {
      readValue: api.readValue,
      writeValue: api.writeValue,
      *replaceValue(input: { key: string; value: string }) {
        const current = yield* self.readValue({ key: input.key });
        return yield* self.writeValue({
          key: input.key,
          value: input.value,
          expectedRevision: current.revision,
        });
      },
    };
  },
});

const alternativeData = defineDurableContextExtension({
  name: "data",
  api: Data.operations,
  client({ api }) {
    return {
      *readValue(input: { key: string }) {
        return yield* api.readValue({ key: `alternative:${input.key}` });
      },
      writeValue: api.writeValue,
    };
  },
});

const otherData = defineDurableContextExtension({ name: "other-data", api: Data.operations });

function compileOnlyTypeAssertions(): void {
  createDurableTool("extension_types")
    .description("Compile-only context extension assertions")
    .identity({ version: "1", digest: sha256("extension-types") })
    .parameters(z.object({}))
    .uses({ data })
    .execute(function* (_input, context) {
      const valid: string = (yield* context.data.readValue({ key: "ok" })).value;
      void valid;
      // @ts-expect-error readValue requires a string key
      yield* context.data.readValue({ key: 1 });
      // @ts-expect-error token was not declared through .uses()
      yield* context.use(otherData).readValue({ key: "missing" });
      // @ts-expect-error output value is a string, not a number
      const wrong: number = (yield* context.use(data).readValue({ key: "ok" })).value;
      return { wrong };
    });
}
void compileOnlyTypeAssertions;

function buildTool(extension: typeof data = data) {
  return createDurableTool("extension_fixture")
    .description("Exercises an ordinary typed context extension")
    .identity({ version: "1", digest: sha256("extension-fixture") })
    .parameters(z.object({ key: z.string(), value: z.string() }))
    .uses({ data: extension })
    .execute(function* (input, context) {
      const direct = yield* context.data.readValue({ key: input.key });
      const explicit = yield* context.use(extension).readValue({ key: input.key });
      return { direct, explicit };
    });
}

function rejectBoundary(_proposal: ProgramStepProposal): Operation<ProgramResume> {
  return (function* () {
    throw new Error("ordinary extension unexpectedly proposed a durable boundary");
  })();
}

describe("durable context extensions", () => {
  it("projects alias and token clients without synthesizing effects", async () => {
    const tool = buildTool();
    expect(tool.manifest.effects).toEqual({});

    await expect(
      run(function* () {
        yield* Data.around({
          *readValue(args) {
            return { value: `value:${args[0].key}`, revision: "r1" };
          },
        });
        const context = createDurableProgramContext(rejectBoundary);
        return yield* tool.program({ key: "answer", value: "42" }, context);
      }),
    ).resolves.toEqual({
      direct: { value: "value:answer", revision: "r1" },
      explicit: { value: "value:answer", revision: "r1" },
    });
  });

  it("applies middleware to composed methods and recursive self calls", async () => {
    const tool = createDurableTool("extension_middleware_fixture")
      .description("Exercises recursive extension middleware")
      .identity({ version: "1", digest: sha256("extension-middleware-fixture") })
      .parameters(z.object({ key: z.string(), value: z.string() }))
      .uses({ data })
      .execute(function* (input, context) {
        return yield* context.data.replaceValue(input);
      });
    const order: string[] = [];

    const result = await run(function* () {
      yield* Data.around({
        *readValue() {
          return { value: "old", revision: "r1" };
        },
        *writeValue() {
          return { revision: "r2" };
        },
      });
      yield* data.clientApi.around({
        *replaceValue(args, next) {
          order.push("replace:before");
          const value = yield* next(...args);
          order.push("replace:after");
          return value;
        },
        *readValue(args, next) {
          order.push("read:before");
          const value = yield* next(...args);
          order.push("read:after");
          return value;
        },
        *writeValue(args, next) {
          order.push("write:before");
          const value = yield* next(...args);
          order.push("write:after");
          return value;
        },
      });
      const context = createDurableProgramContext(rejectBoundary);
      return yield* tool.program({ key: "answer", value: "42" }, context);
    });

    expect(result).toEqual({ revision: "r2" });
    expect(order).toEqual([
      "replace:before",
      "read:before",
      "read:after",
      "write:before",
      "write:after",
      "replace:after",
    ]);
  });

  it("allows a semantic extension method to suspend at one explicit durable effect", async () => {
    const lookup = defineEffect({
      name: "extension.lookup",
      version: "1",
      input: z.object({ key: z.string() }),
      output: z.object({ value: z.string() }),
      retrySafety: { mode: "repeatable" },
    });
    const extension = defineDurableContextExtension({
      name: "effectful-client",
      api: {
        *lookup(_input: { key: string }): Operation<{ value: string }> {
          throw new Error("not installed");
        },
      },
      client({ context }) {
        return {
          *lookup(input: { key: string }) {
            return yield* context.effect(lookup, input, { audience: "test" });
          },
        };
      },
    });
    const tool = createDurableTool("effectful_extension")
      .description("Explicit effect through extension")
      .identity({ version: "1", digest: sha256("effectful-extension") })
      .parameters(z.object({ key: z.string() }))
      .uses({ extension })
      .effects({ [lookup.name]: lookup })
      .execute(function* (input, context) {
        const first = yield* context.extension.lookup(input);
        const second = yield* context.effect(
          lookup,
          { key: `${input.key}:second` },
          {
            audience: "test",
          },
        );
        return { first, second };
      });
    const driver = createLocalProgramDriver(createDurableToolRegistry([tool]));
    await run(function* () {
      const attachment = yield* driver.attach({
        sessionId: "session",
        taskId: "task",
        program: {
          id: tool.manifest.programId,
          version: tool.manifest.version,
          digest: tool.manifest.digest,
        },
        input: { key: "answer" },
        route: { driverKind: "program" },
        executionEpoch: 1,
      });
      const effect = yield* driver.step(attachment, {
        type: "start",
        input: { key: "answer" },
      });
      expect(effect).toMatchObject({
        type: "operation",
        descriptor: { kind: "effect", input: { key: "answer" } },
      });
      if (effect.type !== "operation") {
        throw new Error("expected effect");
      }
      const secondEffect = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: effect.actionIndex,
        outcome: { status: "ok", value: { value: "42" } },
        receipt: {
          sessionId: "session",
          taskId: "task",
          pullId: "pull",
          resolutionOffset: "1",
          outcomeDigest: "a".repeat(64),
          status: "accepted",
        },
        replayed: false,
      });
      expect(secondEffect).toMatchObject({
        type: "operation",
        descriptor: { input: { key: "answer:second" } },
      });
      if (secondEffect.type !== "operation") {
        throw new Error("expected second effect");
      }
      const completed = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: secondEffect.actionIndex,
        outcome: { status: "ok", value: { value: "43" } },
        receipt: {
          sessionId: "session",
          taskId: "task",
          pullId: "pull-2",
          resolutionOffset: "2",
          outcomeDigest: "b".repeat(64),
          status: "accepted",
        },
        replayed: false,
      });
      expect(completed).toMatchObject({
        type: "completed",
        value: { first: { value: "42" }, second: { value: "43" } },
      });
      yield* driver.shutdown(attachment, "completed");
    });
  });

  it("pins semantic client identity but not provider middleware", async () => {
    expect(buildTool(data).manifest.digest).not.toBe(buildTool(alternativeData).manifest.digest);
    const digest = buildTool(data).manifest.digest;
    await run(function* () {
      yield* Data.around({
        *readValue() {
          return { value: "deployment-specific", revision: "r9" };
        },
      });
    });
    expect(buildTool(data).manifest.digest).toBe(digest);
  });

  it("rejects duplicate tokens and reserved aliases", () => {
    expect(() =>
      createDurableTool("duplicate_extension")
        .description("duplicate")
        .identity({ version: "1", digest: sha256("duplicate-extension") })
        .parameters(z.object({}))
        .uses({ data, duplicate: data }),
    ).toThrow(/declared more than once/);

    expect(() =>
      createDurableTool("reserved_extension")
        .description("reserved")
        .identity({ version: "1", digest: sha256("reserved-extension") })
        .parameters(z.object({}))
        .uses({ effect: data }),
    ).toThrow(/Reserved durable context extension alias/);
  });
});
