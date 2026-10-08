import { expect, it } from "vitest";
import {
  createCapabilityKeyring,
  signCapability,
  verifyProgramCapability,
} from "../contract/capabilities.ts";

it("retains authentication without retaining authorization or caller mutations", () => {
  const keys = [{ keyId: "old", secret: "x".repeat(32) }];
  const keyring = createCapabilityKeyring("test", keys);
  const claims = {
    journalId: "journal",
    journalIncarnation: "1",
    sessionId: "session",
    taskId: "task",
    programId: "program",
    programVersion: "1",
    programDigest: "a".repeat(64),
    attachmentId: "attachment",
    executionEpoch: 1,
    audience: "caller",
    permissions: ["propose", "complete"] as ["propose", "complete"],
    nonce: "nonce",
  };
  const token = signCapability(claims, keyring);
  const returned = verifyProgramCapability(token, keyring, claims);
  returned.audience = "tampered";
  returned.permissions.splice(0);
  expect(verifyProgramCapability(token, keyring, claims)).toMatchObject({
    audience: "caller",
    permissions: ["propose", "complete"],
  });
  expect(() => verifyProgramCapability(token, keyring, { ...claims, audience: "other" })).toThrow(
    "wrong_audience",
  );
  expect(() => verifyProgramCapability(token, keyring, { ...claims, executionEpoch: 2 })).toThrow(
    "stale_program_capability",
  );
  expect(() =>
    verifyProgramCapability(token, keyring, { ...claims, attachmentId: "other" }),
  ).toThrow("stale_program_capability");
  expect(() => verifyProgramCapability(`${token}x`, keyring, claims)).toThrow();
  const retired = createCapabilityKeyring("test", [
    { ...keys[0]!, status: "retired" },
    { keyId: "new", secret: "y".repeat(32) },
  ]);
  expect(() => verifyProgramCapability(token, retired, claims)).toThrow();
});
