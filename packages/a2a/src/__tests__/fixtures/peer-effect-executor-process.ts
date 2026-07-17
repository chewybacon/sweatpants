import { existsSync, readFileSync, writeFileSync } from "node:fs";

const countPath = required("PEER_EFFECT_COUNT_PATH");
const credential = required("CALLER_ONLY_CREDENTIAL");
const approved = required("HUMAN_APPROVED") === "true";
const input = JSON.parse(required("PEER_EFFECT_INPUT"));
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
if (!approved) {
  process.stdout.write(
    JSON.stringify({
      status: "error",
      error: { code: "approval_denied", message: "Human denied" },
    }),
  );
} else {
  process.stdout.write(
    JSON.stringify({
      status: "ok",
      value: `approved:${String(input)}:${credential.slice(0, 4)}`,
    }),
  );
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
