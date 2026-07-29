/**
 * Type-level tests for the plugin handle API in useChat.
 *
 * Verifies:
 * - REQ-020: useChat accepts full plugin objects in `plugins`.
 * - REQ-022: `enabledPlugins` is rejected (removed option).
 * - REQ-023: `tools` and `plugins` are separate options.
 * - NFR-003: `.client` registrations are not accepted in `plugins`.
 */
import { describe, it, expect } from "vitest";
import type {
  PluginClientRegistrationInput,
  PluginHandleInput,
} from "@sweatpants/tool-session/mcp";
import type { UseChatOptions } from "../useChat.ts";

// A structurally-constructed plugin handle fixture (no zod needed for type tests).
const clientReg: PluginClientRegistrationInput = {
  toolName: "tictactoe",
  handlers: {
    pickMove: (() => ({ action: "accept", content: { cell: 0 } })) as never,
  },
  schemas: { pickMove: {} as never },
};

const tictactoePlugin: PluginHandleInput = {
  tool: { name: "tictactoe" },
  server: {
    toolName: "tictactoe",
    execution: "ordinary",
    contract: { name: "tictactoe" },
  },
  client: clientReg,
};

const calculator = { name: "calculator" };

describe("plugin handle API types", () => {
  it("useChat accepts full plugin objects and tool handles separately", () => {
    const options: UseChatOptions = {
      tools: [calculator],
      plugins: [tictactoePlugin],
    };
    expect(options.plugins).toHaveLength(1);
  });

  // REQ-022 / NFR-003: enabledPlugins is no longer accepted.
  it("rejects enabledPlugins as a useChat option", () => {
    // @ts-expect-error - enabledPlugins was removed
    const _options: UseChatOptions = { enabledPlugins: ["tictactoe"] };
    expect(_options).toBeTruthy();
  });

  // NFR-003: passing a bare `.client` registration is not accepted.
  it("rejects .client registrations in plugins", () => {
    // @ts-expect-error - full plugin handles are required, not .client fragments
    const _options: UseChatOptions = { plugins: [tictactoePlugin.client] };
    expect(_options).toBeTruthy();
  });
});
