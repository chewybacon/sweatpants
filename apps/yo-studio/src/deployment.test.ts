import { describe, expect, it } from "vitest";

import { studioDeployment } from "./deployment.ts";

const digest = /^[a-f0-9]{64}$/;

describe("yo-studio authored deployment", () => {
  it("assembles one journal-native coding harness from a closed workspace capability map", () => {
    expect(studioDeployment.name).toBe("yo-studio");
    expect(studioDeployment.modelProvider).toMatchObject({
      adapter: "pi-ai",
      model: { provider: "github-copilot", id: "gpt-5.5" },
    });
    expect(studioDeployment.modelSampling).toEqual({
      format: "sweatpants.model-sampling.v1",
      provider: "coding",
      ownership: "host",
    });
    expect(studioDeployment.programs.code.kind).toBe("sweatpants.chat-program");
    expect(studioDeployment.programs.code.manifest.digest).toMatch(digest);
    expect(Object.keys(studioDeployment.capabilities)).toEqual([
      "workspace_inspect",
      "workspace_read",
      "workspace_list",
      "workspace_write",
      "workspace_test",
      "play_ttt",
    ]);
    expect(studioDeployment.programs.code.childPrograms).toHaveProperty("workspace_inspect");
    expect(studioDeployment.programs.code.childPrograms).toHaveProperty("workspace_read");
    expect(studioDeployment.programs.code.childPrograms).toHaveProperty("workspace_list");
    expect(studioDeployment.programs.code.childPrograms).toHaveProperty("workspace_write");
    expect(studioDeployment.programs.code.childPrograms).toHaveProperty("workspace_test");
    expect(studioDeployment.programs.code.childPrograms).toHaveProperty("play_ttt");
  });

  it("keeps provider identity and secret values out of authored program configuration", () => {
    const authored = JSON.stringify(studioDeployment.programs.code.configuration);
    expect(authored).not.toContain("microvm-");
    expect(authored).not.toContain("lambda-microvm.us-east-1.on.aws");
    expect(authored).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(authored).not.toContain("X-aws-proxy-auth");
    expect(studioDeployment.sandbox.capabilities.workspacePersistence).toBe("sandbox_lease");
    expect(studioDeployment.workspace.policy.network).toBe("trusted-development");
  });
});
