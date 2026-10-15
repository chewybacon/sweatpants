import { describe, expect, it } from "vitest";
import {
  mintPublicHistoryCursor,
  mintWindowToken,
  verifyPublicHistoryCursor,
  verifyWindowToken,
} from "../projection-tokens.ts";

const key = new Uint8Array(32).fill(7);
const prior = new Uint8Array(32).fill(3);
const basis = {
  lineageId: "lineage-1",
  basisRevision: "3",
  archiveFrontierOrdinal: "4",
  nextPublicPosition: "11",
  hotRootPositions: ["9", "10"],
  issuedAt: 100,
  expiresAt: 200,
} as const;

describe("projection tokens", () => {
  it("round-trips canonical window and history bases", async () => {
    const window = await mintWindowToken(basis, { activeKey: key });
    await expect(verifyWindowToken(window, { activeKey: key }, 150)).resolves.toEqual(basis);
    const cursorPayload = { ...basis, beforePosition: "11" };
    const cursor = await mintPublicHistoryCursor(cursorPayload, { activeKey: key });
    await expect(verifyPublicHistoryCursor(cursor, { activeKey: key })).resolves.toEqual(
      cursorPayload,
    );
  });

  it("rejects payload and MAC mutation before decoding authority fields", async () => {
    const token = await mintWindowToken(basis, { activeKey: key });
    const [payload, mac] = token.split(".") as [string, string];
    const changedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${mac}`;
    const changedMac = `${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    await expect(verifyWindowToken(changedPayload, { activeKey: key }, 150)).rejects.toMatchObject({
      code: "public_history_cursor_invalid",
    });
    await expect(verifyWindowToken(changedMac, { activeKey: key }, 150)).rejects.toMatchObject({
      code: "public_history_cursor_invalid",
    });
  });

  it("retains prior verification keys through token lifetime and then expires", async () => {
    const token = await mintWindowToken(basis, { activeKey: prior });
    await expect(
      verifyWindowToken(token, { activeKey: key, verificationKeys: [prior] }, 199),
    ).resolves.toEqual(basis);
    await expect(
      verifyWindowToken(token, { activeKey: key, verificationKeys: [prior] }, 200),
    ).rejects.toMatchObject({ code: "public_history_cursor_expired" });
  });
});
