import { expect, it } from "vitest";
import { parseJsonText } from "@sweatpants/foundation";
import { controlFromRow } from "../sql-codec.ts";
import { decodeExecutionControl, encodeExecutionControl } from "../store/store-persistence.ts";
import type { ExecutionControl } from "../store/store.ts";

const row = {
  executionId: "execution",
  controlRevision: "3",
  ownerFence: "2",
  status: "parked",
  rootTaskId: "root",
  stopGeneration: "0",
  requestedDisposition: null,
  controlJson: '{"nested":{"text":"hello 🌍","zero":-0},"array":[true,null]}',
  updatedAt: 1,
};

function roundTrip(input: typeof row): ExecutionControl {
  const { controlJson, ...fields } = input;
  return decodeExecutionControl(
    encodeExecutionControl({
      ...fields,
      control: parseJsonText(controlJson),
    } as ExecutionControl),
  );
}

it("decodes SQL controls with the same values as the byte boundary", () => {
  const decoded = controlFromRow(row);
  expect(decoded).toEqual(roundTrip(row));
  expect(JSON.stringify(decoded)).toBe(JSON.stringify(roundTrip(row)));
  (decoded.control as { nested: { text: string } }).nested.text = "changed";
  expect(controlFromRow(row)).toEqual(roundTrip(row));
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
  { controlJson: '{"__proto__":{"polluted":true}}' },
  { controlJson: '{"nested":{"__proto__":{"polluted":true}}}' },
  { controlJson: '{"number":1e400}' },
  { controlJson: '{"text":"\\ud800"}' },
  { controlJson: "{" },
  { executionId: undefined },
  { executionId: Object.create({ inherited: "bad" }) },
])("preserves SQL rejection at the validation boundary: %j", (override) => {
  const invalid = { ...row, ...override } as typeof row;
  expect(() => roundTrip(invalid)).toThrow();
  expect(() => controlFromRow(invalid)).toThrow();
});
