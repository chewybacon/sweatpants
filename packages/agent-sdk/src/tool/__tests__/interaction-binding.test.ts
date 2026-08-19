import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INTERACTION_BINDING_DOMAIN,
  compileInteractionBinding,
  createDurableTool,
  createTool,
  parseInteractionBinding,
} from "../../index.ts";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";

const descriptor = (identity: string, digest: string): PortableSchemaDescriptor => ({
  identity,
  role: "elicit_response",
  version: "1",
  vendor: "fixture",
  inputProjection: { type: "string" },
  outputProjection: { type: "string" },
  fidelity: { input: "lossless", output: "lossless" },
  digest,
});

describe("InteractionBinding", () => {
  it("compiles the versioned canonical evidence vector", () => {
    expect(INTERACTION_BINDING_DOMAIN).toBe("sweatpants.interaction-binding.v1\n");
    expect(
      compileInteractionBinding({
        ownerInterfaceDigest: "a".repeat(64),
        kind: "elicit",
        key: "choose",
        response: descriptor("tool:fixture/elicits/choose/response", "b".repeat(64)),
        context: null,
        metadata: { nested: { z: 1, a: true }, ui: "choice" },
      }),
    ).toEqual({ id: "66c9a68a3a13e2ea178e8274f9fbcc4b6acceeb81e870d2ef25dbe2be3c00773" });
  });

  it("uses the same binding identity for equivalent ordinary and durable tools", () => {
    const elicits = {
      choose: {
        response: z.object({ value: z.string() }),
        context: z.object({ options: z.array(z.string()) }),
        metadata: { ui: "choice" },
      },
    };
    const ordinary = createTool("binding_parity_tool")
      .description("Binding parity")
      .parameters(z.object({}))
      .elicits(elicits)
      .execute(function* () {
        return null;
      });
    const durable = createDurableTool("binding_parity_tool", { version: "1" })
      .description("Binding parity")
      .parameters(z.object({}))
      .elicits(elicits)
      .execute(function* () {
        return null;
      });

    expect(durable.interfaceDigest).toBe(ordinary.interfaceDigest);
    expect(durable.bindings.elicits["choose"]).toEqual(ordinary.bindings.elicits["choose"]);
  });

  it("strictly parses binding syntax without claiming provenance", () => {
    const valid = { id: "c".repeat(64) };
    expect(parseInteractionBinding(valid)).toEqual(valid);
    for (const invalid of [
      null,
      [],
      {},
      { id: "C".repeat(64) },
      { id: "c".repeat(63) },
      { id: "g".repeat(64) },
      { id: "c".repeat(64), extra: true },
    ]) {
      expect(() => parseInteractionBinding(invalid)).toThrow(/exact object/);
    }
  });

  it("rejects non-JSON authored metadata during tool construction", () => {
    expect(() =>
      createTool("invalid_binding_metadata")
        .description("Invalid metadata")
        .parameters(z.object({}))
        .elicits({
          choose: {
            response: z.string(),
            metadata: { invalid: 1n } as unknown as Record<string, unknown>,
          },
        })
        .execute(function* () {
          return null;
        }),
    ).toThrow();
  });
});
