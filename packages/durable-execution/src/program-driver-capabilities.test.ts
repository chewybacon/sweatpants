import { describe, expect, it } from "vitest";
import type { Operation } from "effection";
import {
  REPLAY_CHECKPOINT_CAPABILITIES,
  createLocalProgramDriver,
  type ProgramDriver,
} from "./index.ts";

function unreachable(): Operation<never> {
  return (function* () {
    throw new Error("metadata-only driver");
  })();
}

describe("ProgramDriver checkpoint capabilities", () => {
  it("classifies the current local driver as replay-only", () => {
    expect(createLocalProgramDriver().capabilities).toEqual({
      replay: { kind: "replay", version: 1 },
    });
    expect(createLocalProgramDriver().capabilities.continuation).toBeUndefined();
  });

  it("permits an optional versioned continuation without changing mandatory replay", () => {
    const driver: ProgramDriver = {
      capabilities: {
        ...REPLAY_CHECKPOINT_CAPABILITIES,
        continuation: {
          kind: "continuation",
          version: "1",
          format: "fixture.continuation.v1",
        },
      },
      attach: unreachable,
      step: unreachable,
      shutdown: unreachable,
    };
    expect(driver.capabilities.replay).toEqual({ kind: "replay", version: 1 });
    expect(driver.capabilities.continuation).toEqual({
      kind: "continuation",
      version: "1",
      format: "fixture.continuation.v1",
    });
  });
});
