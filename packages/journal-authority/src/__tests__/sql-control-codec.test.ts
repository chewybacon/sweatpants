import { expect, it } from "vitest";
import { canonicalJson } from "@sweatpants/foundation";
import { controlFromRow } from "../sql-codec.ts";
import { readExecutionControl } from "../store/store-persistence.ts";
import type { ExecutionControl } from "../store/store.ts";

const row = {
  executionId: "execution",
  controlRevision: "3",
  ownerFence: "2",
  status: "parked",
  rootTaskId: "root",
  stopGeneration: "0",
  requestedDisposition: null,
  controlJson: { nested: { text: "hello 🌍", zero: 0 }, array: [true, null] },
  updatedAt: 1,
};

function roundTrip(input: typeof row): ExecutionControl {
  const { controlJson, ...fields } = input;
  return readExecutionControl({
    ...fields,
    control: controlJson,
  } as ExecutionControl);
}

it("decodes SQL controls with the same values as structured persistence records", () => {
  const decoded = controlFromRow(row);
  expect(decoded).toEqual(roundTrip(row));
  expect(canonicalJson(decoded)).toBe(canonicalJson(roundTrip(row)));
  expect(decoded.control).toBe(row.controlJson);
  expect(controlFromRow({ ...row, updatedAt: 2n })).toEqual({ ...roundTrip(row), updatedAt: 2 });
});

it.each([
  { status: "unknown" },
  { requestedDisposition: "unknown" },
  { controlRevision: "03" },
  { ownerFence: "-1" },
  { stopGeneration: "0.5" },
  { rootTaskId: 42 },
  { executionId: "\ud800" },
  { updatedAt: Infinity },
  { executionId: undefined },
  { executionId: Object.create({ inherited: "bad" }) },
])("preserves SQL rejection at the validation boundary: %j", (override) => {
  const invalid = { ...row, ...override } as typeof row;
  expect(() => roundTrip(invalid)).toThrow();
  expect(() => controlFromRow(invalid)).toThrow();
});
