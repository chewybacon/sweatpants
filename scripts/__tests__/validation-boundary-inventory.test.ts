import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertInventory,
  assertInventoryEvidence,
  assertManualShapeOwnerCoverage,
  readInventory,
  scanManualShapeOwners,
  scanUncheckedBoundaryCasts,
  scanValidationDeclarations,
} from "../validation-boundary-inventory.ts";

describe("validation boundary inventory", () => {
  it("covers every production validate declaration and Standard Schema callback", () => {
    const declarations = scanValidationDeclarations();
    const inventory = readInventory();
    assertInventory(inventory);
    assertInventoryEvidence(inventory);
    const activeEntries = inventory.entries.filter((entry) => entry.disposition !== "delete");
    const declarationLocators = declarations.map(
      (declaration) => `${declaration.file}:${declaration.line}:${declaration.symbol}`,
    );

    expect(inventory.format).toBe("sweatpants.validation-boundary-inventory.v2");
    expect(new Set(inventory.entries.map((entry) => entry.id)).size).toBe(inventory.entries.length);
    expect(
      new Set(
        inventory.entries.map((entry) => `${entry.file}:${entry.symbol}:${entry.evidence[0]}`),
      ).size,
    ).toBe(inventory.entries.length);
    expect(activeEntries).toHaveLength(declarations.length);
    expect(
      activeEntries.every((entry) => {
        const evidence = entry.evidence[0] ?? "";
        const match = /^(.*):(\d+)$/u.exec(evidence);
        return (
          match !== null &&
          match[1] === entry.file &&
          declarationLocators.includes(`${entry.file}:${match[2]}:${entry.symbol}`)
        );
      }),
    ).toBe(true);
  });

  it("rejects direct decode-to-domain casts while allowing unknown and Json containment", () => {
    const directory = mkdtempSync(join(tmpdir(), "validation-boundary-casts-"));
    const invalid = join(directory, "invalid.ts");
    const valid = join(directory, "valid.ts");
    const jsonContained = join(directory, "json-contained.ts");
    try {
      writeFileSync(invalid, "const value = JSON.parse(text) as DomainType;\n");
      writeFileSync(valid, "const value: unknown = JSON.parse(text); parseDomain(value);\n");
      // `Json` is what JSON.parse actually returns; it asserts no domain shape.
      writeFileSync(jsonContained, "const value = JSON.parse(text) as Json;\n");
      expect(scanUncheckedBoundaryCasts([invalid])).toHaveLength(1);
      expect(scanUncheckedBoundaryCasts([valid])).toEqual([]);
      expect(scanUncheckedBoundaryCasts([jsonContained])).toEqual([]);
      expect(scanUncheckedBoundaryCasts()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed inventory records", () => {
    expect(() => assertInventory({ format: "wrong", entries: [] })).toThrow();
    expect(() =>
      assertInventory({
        format: "sweatpants.validation-boundary-inventory.v2",
        entries: [{ id: "VAL-1", file: "x", symbol: "validateX" }],
        shapeOwners: [],
      }),
    ).toThrow();
  });

  it("covers every production manual shape-inspection owner", () => {
    const inventory = readInventory();
    expect(scanManualShapeOwners().length).toBeGreaterThan(0);
    expect(() => assertManualShapeOwnerCoverage(inventory)).not.toThrow();
    expect(() =>
      assertManualShapeOwnerCoverage(inventory, [
        {
          file: "packages/example/src/raw.ts",
          line: 1,
          symbol: "parseRaw",
          declarationKind: "function",
        },
      ]),
    ).toThrow(/unclassified/u);
  });

  it("requires exact, justified shape-owner classifications", () => {
    const inventory = readInventory();
    for (const owner of inventory.shapeOwners) {
      expect(["B", "R", "S", "G", "C"]).toContain(owner.classification);
      if (owner.classification === "G" || owner.classification === "C") {
        expect(owner.rationale?.length).toBeGreaterThan(0);
      } else {
        expect(owner.authority?.length).toBeGreaterThan(0);
      }
    }
  });

  it("requires independent trust and seam labels", () => {
    const inventory = readInventory();
    for (const entry of inventory.entries) {
      expect(["B", "I", "B+GAP", "D"]).toContain(entry.trust);
      if (entry.disposition === "delete") {
        expect(entry.replacement).toBeDefined();
      }
      expect(entry.seams.length).toBeGreaterThan(0);
      for (const seam of entry.seams) {
        expect(["FI", "AD", "UA"]).toContain(seam);
      }
      expect([
        "parse",
        "safe-parse",
        "assert",
        "verify",
        "standard-schema-callback",
        "delete",
      ]).toContain(entry.disposition);
    }
  });
});
