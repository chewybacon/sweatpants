import { canonicalJson } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import { readCommandReceipt, serializeCommandReceipt } from "../persistence.ts";
import { receiptFromRow, receiptToRow } from "../sql-codec.ts";

const receipt = {
  conversationId: "conversation",
  commandId: "command",
  commandDigest: "digest",
  participantId: "participant",
  acceptedAt: 1,
  retainUntil: 2,
  admittedRevision: "0",
  resultingRevision: "1",
};

describe("command receipt codec", () => {
  it("gives absent and undefined optionals the same canonical representation", () => {
    const input = { ...receipt, logicalTurnId: undefined, executionId: undefined };
    const encoded = serializeCommandReceipt(input);

    expect(encoded).toStrictEqual(receipt);
    expect(canonicalJson(encoded)).toBe(canonicalJson(serializeCommandReceipt(receipt)));
    expect(readCommandReceipt(input)).toStrictEqual(encoded);
    expect(receiptFromRow(receiptToRow(input))).toStrictEqual(encoded);
    expect(Object.hasOwn(input, "logicalTurnId")).toBe(true);
  });

  it.each([
    { logicalTurnId: "turn", executionId: "execution" },
    { logicalTurnId: "", executionId: "" },
    { logicalTurnId: "turn" },
    { executionId: "execution" },
  ])("preserves independently supplied identifiers: %j", (identifiers) => {
    const input = { ...receipt, ...identifiers };

    expect(serializeCommandReceipt(input)).toStrictEqual(input);
    expect(readCommandReceipt(input)).toStrictEqual(input);
    expect(receiptFromRow(receiptToRow(input))).toStrictEqual(input);
  });

  it("keeps SQL null handling at the row boundary", () => {
    expect(receiptFromRow({ ...receipt, logicalTurnId: null, executionId: null })).toStrictEqual(
      receipt,
    );
    expect(() => readCommandReceipt({ ...receipt, logicalTurnId: null })).toThrow(
      "receipt.logicalTurnId must be a string",
    );
  });

  it("does not silently strip undefined from unrecognized payload fields", () => {
    const input = { ...receipt, extra: undefined };
    expect(() => serializeCommandReceipt(input)).toThrow();
  });
});
