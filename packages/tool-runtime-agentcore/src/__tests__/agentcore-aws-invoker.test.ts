import { describe, expect, it } from "vitest";

import { parseAgentCoreSseResponses } from "../agentcore/agentcore-aws-invoker.ts";

describe("parseAgentCoreSseResponses", () => {
  it("parses structurally valid provider responses", () => {
    expect(
      parseAgentCoreSseResponses(
        `data: ${JSON.stringify({ type: "session_not_found", toolSessionId: "session-1" })}\n\n`,
      ),
    ).toEqual([{ type: "session_not_found", toolSessionId: "session-1" }]);
  });

  it("rejects malformed provider response structures", () => {
    expect(() =>
      parseAgentCoreSseResponses(`data: ${JSON.stringify({ type: "session_not_found" })}\n\n`),
    ).toThrow("AgentCore returned a malformed tool-runtime response");
  });
});
