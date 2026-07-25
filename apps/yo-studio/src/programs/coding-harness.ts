import { defineChatProgram, modelTool } from "@sweatpants/framework/chat";

import {
  playTttTool,
  workspaceInspectTool,
  workspaceListTool,
  workspaceReadTool,
  workspaceTestTool,
  workspaceWriteTool,
} from "../capabilities/index.ts";
import { CODING_HARNESS_ID, CODING_HARNESS_ITERATIONS, CODING_HARNESS_VERSION } from "../config.ts";

/**
 * A Sweatpants-native coding harness: the durable chat root owns the model
 * loop; task-affine workspace tools are ordinary child programs from its
 * closed capability map.
 */
export const codingHarness = defineChatProgram({
  identity: { name: CODING_HARNESS_ID, version: CODING_HARNESS_VERSION },
  systemPrompt: {
    text: [
      "You are a coding agent operating in one isolated task workspace.",
      "Call workspace_inspect first and retain its workspaceRevision.",
      "Inspect files before changing them; observations return their current workspaceRevision.",
      "Pass the latest observed workspaceRevision as expectedWorkspaceRevision to every write and validation operation.",
      "Use only deployment-declared validation scripts.",
      "Use play_ttt when asked to play tic-tac-toe; it persists the complete game and cumulative record in the workspace.",
      "After play_ttt completes, read both returned paths before reporting the game result.",
      "Never claim a change is complete until the relevant validation script succeeds.",
      "Summarize changed files and validation results when you finish.",
    ].join("\n"),
    classification: "internal",
  },
  tools: {
    workspace_inspect: modelTool(workspaceInspectTool, { resultClassification: "internal" }),
    workspace_read: modelTool(workspaceReadTool, { resultClassification: "internal" }),
    workspace_list: modelTool(workspaceListTool, { resultClassification: "internal" }),
    workspace_write: modelTool(workspaceWriteTool, { resultClassification: "internal" }),
    workspace_test: modelTool(workspaceTestTool, { resultClassification: "internal" }),
    play_ttt: modelTool(playTttTool, { resultClassification: "internal" }),
  },
  sampling: { toolChoice: "auto", maxTokens: 4_096 },
  maxIterations: CODING_HARNESS_ITERATIONS,
});
