import { playTttTool } from "./tic-tac-toe.ts";
import {
  workspaceInspectTool,
  workspaceListTool,
  workspaceReadTool,
  workspaceTestTool,
  workspaceWriteTool,
} from "./workspace.ts";

export const codingCapabilities = {
  workspace_inspect: workspaceInspectTool,
  workspace_read: workspaceReadTool,
  workspace_list: workspaceListTool,
  workspace_write: workspaceWriteTool,
  workspace_test: workspaceTestTool,
  play_ttt: playTttTool,
} as const;

export { playTttTool } from "./tic-tac-toe.ts";
export {
  workspace,
  workspaceInspectTool,
  workspaceListTool,
  workspaceReadTool,
  workspaceTestTool,
  workspaceWriteTool,
} from "./workspace.ts";
