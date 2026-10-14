import { expect, it } from "vitest";
import { reasoningLevel } from "../model-settings.ts";
import { modelOptions } from "../../../scripts/model-options.ts";

it("defaults to medium and rejects misspelled reasoning levels", () => {
  expect(reasoningLevel()).toBe("medium");
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    expect(reasoningLevel(level)).toBe(level);
  }
  expect(() => reasoningLevel("hgh")).toThrow("Unsupported reasoning level");
});
it("selects a provider-specific default and parses the port", () => {
  expect(modelOptions([], {})).toMatchObject({
    provider: "opencode",
    model: "claude-haiku-5-5",
    thinking: "medium",
  });
  expect(modelOptions(["--provider", "github-copilot", "--port", "8104"], {})).toMatchObject({
    provider: "github-copilot",
    model: "gpt-6.1-sol",
    port: "8104",
    astroArgs: [],
  });
});
it("lets flags override environment settings", () => {
  expect(
    modelOptions(
      [
        "--",
        "--provider=github-copilot",
        "--model",
        "claude-opus-5.5",
        "--thinking=high",
        "--list-models",
      ],
      {
        DEFAULT_CHAT_MODEL_PROVIDER: "opencode",
        DEFAULT_CHAT_MODEL_ID: "claude-haiku-5-5",
        DEFAULT_CHAT_MODEL_THINKING: "low",
      },
    ),
  ).toMatchObject({
    provider: "github-copilot",
    model: "claude-opus-5.5",
    thinking: "high",
    listModels: true,
  });
  expect(() => modelOptions(["--model", "--thinking", "high"], {})).toThrow("requires a value");
  expect(() => modelOptions(["--provider", "typo"], {})).toThrow("Unsupported yo-tisyn provider");
});

it("passes extra Astro options through and validates the port", () => {
  expect(modelOptions(["--ignore-lock"], {}).astroArgs).toEqual(["--ignore-lock"]);
  expect(() => modelOptions(["--port=0"], {})).toThrow("--port");
});

it("does not carry an inherited model across an explicit provider change", () => {
  expect(
    modelOptions(["--provider", "github-copilot"], {
      DEFAULT_CHAT_MODEL_PROVIDER: "opencode",
      DEFAULT_CHAT_MODEL_ID: "claude-haiku-5-5",
    }).model,
  ).toBe("gpt-6.1-sol");
});
