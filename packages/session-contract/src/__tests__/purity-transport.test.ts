import { describe, expect, it } from "vitest";

import {
  InMemoryMcpRequestStateStore,
  MCP_DURABLE_EFFECTS_EXTENSION,
  classifyMcpToolDurability,
  recoverMcpRequestState,
} from "../index.ts";
import { scanDurableProgramSources } from "@sweatpants/durable-execution";

describe("durable purity and transport boundaries", () => {
  it("scans the controlled static graph and rejects ambient nondeterminism and unlisted packages", () => {
    const result = scanDurableProgramSources({
      entry: "src/tool.ts",
      modules: {
        "src/tool.ts": {
          id: "src/tool.ts",
          source: `import { pure } from './pure'; import leftpad from 'leftpad'; export function* tool() { return Math.random() + pure(); }`,
        },
        "src/pure.ts": { id: "src/pure.ts", source: "export const pure = () => 1" },
      },
    });
    expect(result.assurance).toBe("guardrail_only");
    expect(result.scanned).toEqual(["src/pure.ts", "src/tool.ts"]);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "banned_api", detail: "Math.random" }),
        expect.objectContaining({ code: "unlisted_external_package", detail: "leftpad" }),
      ]),
    );
  });

  it("classifies MCP durability honestly and stores only encrypted caller-bound latest request state", () => {
    expect(classifyMcpToolDurability({})).toBe("opaque");
    expect(classifyMcpToolDurability({ serverTask: true })).toBe("server_task");
    expect(
      classifyMcpToolDurability({
        negotiatedExtensions: [MCP_DURABLE_EFFECTS_EXTENSION],
        supportsFreshReplay: true,
      }),
    ).toBe("crank_native");
    expect(
      classifyMcpToolDurability({
        negotiatedExtensions: [MCP_DURABLE_EFFECTS_EXTENSION],
        supportsFreshReplay: false,
      }),
    ).toBe("opaque");

    const cipher = {
      seal(value: Uint8Array, aad: string) {
        const mask = aad.length % 251;
        return value.map((byte) => byte ^ mask);
      },
      open(value: Uint8Array, aad: string) {
        const mask = aad.length % 251;
        return value.map((byte) => byte ^ mask);
      },
    };
    const store = new InMemoryMcpRequestStateStore({ cipher });
    const plaintext = new TextEncoder().encode("private checkpoint");
    store.put("turn-0/root", "caller-a", plaintext);
    expect(store.inspectEncrypted("turn-0/root")?.ciphertext).not.toEqual(plaintext);
    expect(store.get("turn-0/root", "caller-b")).toBeUndefined();
    expect(new TextDecoder().decode(store.get("turn-0/root", "caller-a"))).toBe(
      "private checkpoint",
    );
    store.put("turn-0/root", "caller-a", new TextEncoder().encode("latest"));
    expect(new TextDecoder().decode(store.get("turn-0/root", "caller-a"))).toBe("latest");
    store.deleteTerminal("turn-0/root");
    expect(
      recoverMcpRequestState({
        store,
        invocationId: "turn-0/root",
        callerId: "caller-a",
        freshReplay: () => "replayed",
      }),
    ).toEqual({ mode: "fresh_replay", value: "replayed" });
  });
});
