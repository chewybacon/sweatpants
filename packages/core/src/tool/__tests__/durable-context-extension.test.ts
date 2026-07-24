import { run, useScope } from "effection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bindDurableProgramScope,
  createDurableProgramContext,
  sha256,
} from "@sweatpants/session-contract";

import { createDurableTool } from "../durable-create.ts";
import { defineDurableContextExtension } from "../durable-context-extension.ts";
import { defineEffect } from "../durable-effect.ts";

const readValue = defineEffect({
  name: "acceptance.data.read",
  version: "1",
  input: z.object({ key: z.string() }),
  output: z.object({ value: z.string(), revision: z.string() }),
  retrySafety: { mode: "repeatable" },
});

const writeValue = defineEffect({
  name: "acceptance.data.write",
  version: "1",
  input: z.object({ key: z.string(), value: z.string(), expectedRevision: z.string() }),
  output: z.object({ revision: z.string() }),
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const data = defineDurableContextExtension({
  name: "data",
  effects: { readValue, writeValue },
  client({ effect, self }) {
    return {
      *readValue(input: { key: string }) {
        return yield* effect(readValue, input);
      },
      *writeValue(input: { key: string; value: string; expectedRevision: string }) {
        return yield* effect(writeValue, input);
      },
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
  effects: { readValue, writeValue },
  client({ effect }) {
    return {
      *readValue(input: { key: string }) {
        return yield* effect(readValue, { key: `alternative:${input.key}` });
      },
      *writeValue(input: { key: string; value: string; expectedRevision: string }) {
        return yield* effect(writeValue, input);
      },
    };
  },
});

const otherData = defineDurableContextExtension({
  name: "other-data",
  effects: { readValue },
});

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
      // @ts-expect-error the token was not declared through .uses()
      yield* context.use(otherData).readValue({ key: "missing" });
      // @ts-expect-error the output value is a string, not a number
      const wrong: number = (yield* context.use(data).readValue({ key: "ok" })).value;
      return wrong;
    });
}
void compileOnlyTypeAssertions;

function buildTool() {
  return createDurableTool("extension_fixture")
    .description("Exercises a typed durable context extension")
    .identity({ version: "1", digest: sha256("extension-fixture") })
    .parameters(z.object({ key: z.string(), value: z.string() }))
    .uses({ data })
    .execute(function* (input, context) {
      const direct = yield* context.data.readValue({ key: input.key });
      const explicit = yield* context.use(data).readValue({ key: input.key });
      const replaced = yield* context.data.replaceValue(input);
      return { direct, explicit, replaced };
    });
}

describe("durable context extensions", () => {
  it("adds exact effects and exposes alias and token clients", async () => {
    const tool = buildTool();
    expect(Object.keys(tool.manifest.effects).sort()).toEqual([
      "acceptance.data.read",
      "acceptance.data.write",
    ]);

    await run(function* () {
      const context = createDurableProgramContext();
      bindDurableProgramScope(context, yield* useScope());
      const generator = tool.program({ key: "answer", value: "42" }, context);
      const alias = generator.next();
      expect(alias.value).toMatchObject({
        type: "operation",
        descriptor: {
          kind: "effect",
          name: "acceptance.data.read",
          input: { key: "answer" },
          resolver: { audience: "extension:data" },
        },
      });
      const token = generator.next({
        status: "ok",
        value: { value: "old", revision: "r1" },
      });
      expect(token.value).toMatchObject({
        type: "operation",
        descriptor: { name: "acceptance.data.read" },
      });
    });
  });

  it("applies scoped middleware to composed methods and nested self calls", async () => {
    const tool = createDurableTool("extension_middleware_fixture")
      .description("Exercises recursive extension middleware")
      .identity({ version: "1", digest: sha256("extension-middleware-fixture") })
      .parameters(z.object({ key: z.string(), value: z.string() }))
      .uses({ data })
      .execute(function* (input, context) {
        return yield* context.data.replaceValue(input);
      });
    const order: string[] = [];

    await run(function* () {
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
      const context = createDurableProgramContext();
      bindDurableProgramScope(context, yield* useScope());
      const generator = tool.program({ key: "answer", value: "42" }, context);
      expect(generator.next().value).toMatchObject({
        descriptor: { name: "acceptance.data.read" },
      });
      expect(
        generator.next({ status: "ok", value: { value: "old", revision: "r1" } }).value,
      ).toMatchObject({ descriptor: { name: "acceptance.data.write" } });
      expect(generator.next({ status: "ok", value: { revision: "r2" } })).toMatchObject({
        done: true,
        value: { revision: "r2" },
      });
    });

    expect(order).toEqual([
      "replace:before",
      "read:before",
      "read:after",
      "write:before",
      "write:after",
      "replace:after",
    ]);
  });

  it("creates scope-installed Effection providers and exact registrations", async () => {
    const provider = data.implement({
      name: "fixture-provider",
      methods: {
        *readValue(input) {
          return { value: `value:${input.key}`, revision: "r1" };
        },
        *writeValue() {
          return { revision: "r2" };
        },
      },
    });

    expect(
      provider.registrations.map((registration) => registration.definition.name).sort(),
    ).toEqual(["acceptance.data.read", "acceptance.data.write"]);
    await run(function* () {
      yield* provider.install();
      const read = provider.registrations.find(
        (registration) => registration.definition.name === "acceptance.data.read",
      )!;
      expect(
        yield* read.handler(
          { key: "answer" },
          {
            sessionId: "session",
            taskId: "task",
            pullId: "pull",
            attemptId: "attempt",
            cancellation: new AbortController().signal,
            resolver: { audience: "extension:data" },
          },
        ),
      ).toEqual({ status: "ok", value: { value: "value:answer", revision: "r1" } });
    });
  });

  it("pins extension client identity into the durable program", () => {
    const create = (extension: typeof data | typeof alternativeData) =>
      createDurableTool("extension_identity")
        .description("Pins extension client identity")
        .identity({ version: "1", digest: sha256("extension-identity-base") })
        .parameters(z.object({ key: z.string() }))
        .uses({ data: extension })
        .execute(function* (input, context) {
          return yield* context.data.readValue(input);
        });

    expect(create(data).manifest.digest).not.toBe(create(alternativeData).manifest.digest);
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
