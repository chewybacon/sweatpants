/** Deterministic encoding of model data, preserving JavaScript string code units and numbers. */
export function encodeRecordedValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "number") {
    return "number:" + (Object.is(value, -0) ? "-0" : String(value));
  }
  if (typeof value !== "object") {
    throw new Error("Unsupported recorded chat value");
  }
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error("Recorded chat values require plain objects");
  }
  const fields = Object.keys(value)
    .sort()
    .map(
      (key) =>
        JSON.stringify(key) + ":" + encodeRecordedValue((value as Record<string, unknown>)[key]),
    );
  return (array ? "array:" + value.length : "object") + "{" + fields.join(",") + "}";
}
