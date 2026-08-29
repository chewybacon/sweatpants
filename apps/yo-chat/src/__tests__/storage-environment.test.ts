// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createYoChatStorageConfig, yoChatDefaultDbPath } from "../server/storage-config.ts";

describe("yo-chat storage environment", () => {
  it("defaults to SQLite at the app-local path", () => {
    expect(createYoChatStorageConfig({})).toEqual({
      kind: "sqlite",
      path: yoChatDefaultDbPath(),
    });
  });

  it("honors SWEATPANTS_DB_PATH and explicit memory", () => {
    expect(createYoChatStorageConfig({ SWEATPANTS_DB_PATH: "/tmp/yo-chat.sqlite" })).toEqual({
      kind: "sqlite",
      path: "/tmp/yo-chat.sqlite",
    });
    expect(createYoChatStorageConfig({ SWEATPANTS_STORAGE: "memory" })).toEqual({
      kind: "memory",
    });
  });

  it("rejects unknown, empty, and contradictory settings", () => {
    expect(() => createYoChatStorageConfig({ SWEATPANTS_STORAGE: "sqlite" })).toThrow(
      /only accepts "memory"/,
    );
    expect(() => createYoChatStorageConfig({ SWEATPANTS_DB_PATH: "" })).toThrow(/not be empty/);
    expect(() => createYoChatStorageConfig({ SWEATPANTS_DB_PATH: "   " })).toThrow(/not be empty/);
    expect(() =>
      createYoChatStorageConfig({
        SWEATPANTS_STORAGE: "memory",
        SWEATPANTS_DB_PATH: "/tmp/ignored.sqlite",
      }),
    ).toThrow(/cannot be combined/);
  });
});
