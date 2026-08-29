import { describe, expect, it } from "vitest";
import { createYoStudioStorageConfig, YO_STUDIO_DEFAULT_DB_PATH } from "./storage-config.ts";

describe("yo-studio storage configuration", () => {
  it("defaults to SQLite and permits an explicit memory override", () => {
    expect(createYoStudioStorageConfig({})).toEqual({
      kind: "sqlite",
      path: YO_STUDIO_DEFAULT_DB_PATH,
    });
    expect(createYoStudioStorageConfig({ SWEATPANTS_DB_PATH: "/tmp/studio.sqlite" })).toEqual({
      kind: "sqlite",
      path: "/tmp/studio.sqlite",
    });
    expect(createYoStudioStorageConfig({ SWEATPANTS_STORAGE: "memory" })).toEqual({
      kind: "memory",
    });
  });

  it("rejects invalid and contradictory settings", () => {
    expect(() => createYoStudioStorageConfig({ SWEATPANTS_STORAGE: "sqlite" })).toThrow();
    expect(() => createYoStudioStorageConfig({ SWEATPANTS_DB_PATH: "" })).toThrow();
    expect(() =>
      createYoStudioStorageConfig({
        SWEATPANTS_STORAGE: "memory",
        SWEATPANTS_DB_PATH: "/tmp/ignored.sqlite",
      }),
    ).toThrow(/cannot be combined/);
  });
});
