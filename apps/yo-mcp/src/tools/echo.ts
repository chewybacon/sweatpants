/**
 * Echo Tool
 *
 * A simple tool that echoes back the input.
 * Demonstrates the simplest possible MCP tool.
 */
import { z } from "zod";
import { defineJournalTool } from "@sweatpants/agent-sdk/primitive";

export const echoTool = defineJournalTool({
  name: "echo",
  description: "Echo back the input message",
  parameters: z.object({
    message: z.string().describe("The message to echo"),
    uppercase: z.boolean().default(false).describe("Whether to uppercase the message"),
  }),
  elicits: {},
  execute: function* (params) {
    const result = params.uppercase ? params.message.toUpperCase() : params.message;
    return {
      echoed: result,
      length: result.length,
    };
  },
  effects: {},
});
