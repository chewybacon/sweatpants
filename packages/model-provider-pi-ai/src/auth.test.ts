import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import {
  FileCredentialStore,
  readStoredModelSelection,
  selectStoredModel,
  sweatpantsAuthFile,
} from "./auth.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function authPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "sweatpants-model-auth-"));
  directories.push(directory);
  return join(directory, "private", "auth.json");
}

describe("file-backed model credentials", () => {
  it("persists provider credentials and the selected model without exposing secrets in selection", async () => {
    const path = authPath();
    const store = new FileCredentialStore(path);
    await store.modify("opencode", async () => ({ type: "api_key", key: "zen-secret" }));
    selectStoredModel({ provider: "opencode", id: "gpt-5.5" }, path);

    expect(await new FileCredentialStore(path).read("opencode")).toEqual({
      type: "api_key",
      key: "zen-secret",
    });
    expect(readStoredModelSelection(path)).toEqual({ provider: "opencode", id: "gpt-5.5" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("supplies persisted API-key credentials through pi-ai provider resolution", async () => {
    const path = authPath();
    const store = new FileCredentialStore(path);
    await store.modify("opencode", async () => ({ type: "api_key", key: "zen-secret" }));

    const auth = await builtinModels({ credentials: store }).getAuth("opencode");
    expect(auth).toMatchObject({ auth: { apiKey: "zen-secret" } });
  });

  it("serializes provider modifications and clears selection on logout", async () => {
    const path = authPath();
    const store = new FileCredentialStore(path);
    await Promise.all([
      store.modify("openai-codex", async () => ({
        type: "oauth",
        access: "access-one",
        refresh: "refresh-one",
        expires: 1,
        accountId: "account",
      })),
      store.modify("openai-codex", async (current) => ({
        ...(current ?? { type: "oauth", access: "", refresh: "", expires: 0 }),
        access: "access-two",
      })),
    ]);
    selectStoredModel({ provider: "openai-codex", id: "gpt-5.5" }, path);

    expect(await store.read("openai-codex")).toMatchObject({ type: "oauth", access: "access-two" });
    await store.delete("openai-codex");
    expect(readStoredModelSelection(path)).toBeUndefined();
  });

  it("uses a repository-local ignored auth path unless explicitly overridden", () => {
    expect(sweatpantsAuthFile({})).toMatch(/\.sweatpants\/auth\.json$/u);
    expect(sweatpantsAuthFile({ YO_CHAT_MODEL_AUTH_FILE: "/tmp/alternate.json" })).toBe(
      "/tmp/alternate.json",
    );
  });
});
