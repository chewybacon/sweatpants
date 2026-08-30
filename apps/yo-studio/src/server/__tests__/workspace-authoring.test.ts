import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  workspaceInspectTool,
  workspaceListTool,
  workspaceReadTool,
  workspaceTestTool,
  workspaceWriteTool,
} from "../../capabilities/workspace.ts";

describe("yo-studio ordinary workspace authoring", () => {
  it("keeps observations ordinary and mutations explicitly recorded", async () => {
    expect(workspaceInspectTool.manifest.effects).toEqual({});
    expect(workspaceReadTool.manifest.effects).toEqual({});
    expect(workspaceListTool.manifest.effects).toEqual({});
    expect(workspaceWriteTool.manifest.effects).toEqual({});
    expect(workspaceTestTool.manifest.effects).toEqual({});

    const source = await readFile(
      new URL("../../capabilities/workspace.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("return yield* context.workspace.readFile(input)");
    expect(source).toContain("return yield* context.workspace.list(input)");
    expect(source.match(/context\.record\(/g)).toHaveLength(2);
    expect(source).toContain('mechanism: "pull_id_key"');
    expect(source).not.toMatch(
      /WorkspaceConnector|WorkspaceFence|protocolVersion|AWS|authentication/,
    );
  });
});
