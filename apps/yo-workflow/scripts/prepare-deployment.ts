import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FileCredentialStore } from "@sweatpants/model-provider-pi-ai";

const credential = await new FileCredentialStore().read("opencode");
if (!credential || credential.type !== "api_key") {
  throw new Error("A stored OpenCode API key is required; Copilot is not a fallback");
}
mkdirSync(".wrangler", { recursive: true });
const path = ".wrangler/deployment-secrets.json";
const previous = existsSync(path)
  ? (JSON.parse(readFileSync(path, "utf8")) as Partial<Record<string, string>>)
  : {};
const secrets = {
  MODEL_CREDENTIALS: JSON.stringify({ opencode: credential }),
  DEFAULT_CHAT_MODEL_PROVIDER: "opencode",
  DEFAULT_CHAT_MODEL_ID: "claude-haiku-5-5",
  PROGRAM_DRIVER_CAPABILITY_SECRET:
    previous.PROGRAM_DRIVER_CAPABILITY_SECRET ?? randomBytes(32).toString("hex"),
};
writeFileSync(path, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
console.log("Prepared OpenCode / Haiku 5.5 secrets; no Copilot credentials included.");
