/** Shared host capability wire contract; this does not grant filesystem access. */
export const readFileContract = Object.freeze({
  capability: "sandbox.read_file",
  version: "1",
  arguments: { path: "string" },
  result: "string",
  errors: ["ValueError", "FileNotFoundError", "PermissionError", "RuntimeError"],
});
export function parseHostRequest(value) {
  if (
    value?.capability !== readFileContract.capability ||
    typeof value.arguments?.path !== "string" ||
    value.arguments.path.length > 256
  ) {
    throw Error("Invalid sandbox.read_file request");
  }
  return { capability: readFileContract.capability, arguments: { path: value.arguments.path } };
}
export function validHostReply(value) {
  return (
    value &&
    Number.isSafeInteger(value.operationId) &&
    ((typeof value.value === "string" && value.value.length <= 12000 && !value.error) ||
      (!Object.hasOwn(value, "value") &&
        readFileContract.errors.includes(value.error?.type) &&
        typeof value.error.message === "string" &&
        value.error.message.length <= 12000))
  );
}
