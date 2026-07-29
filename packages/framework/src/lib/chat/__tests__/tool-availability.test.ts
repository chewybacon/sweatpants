import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDurableTool, createTool } from "@sweatpants/agent-sdk";
import { sha256 } from "@sweatpants/foundation";
import { createDurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";

import { projectAvailableToolContracts } from "../tool-inventory.ts";

const ordinary = createTool("ordinary")
  .description("ordinary")
  .parameters(z.object({ value: z.string() }))
  .execute(function* ({ value }) {
    return value;
  });

const durable = createDurableTool("durable")
  .description("durable")
  .identity({ version: "1", digest: sha256("availability-durable@1") })
  .parameters(z.object({ value: z.string() }))
  .output(z.string())
  .effects({})
  .execute(function* ({ value }) {
    return value;
  });

const exactProgram = `${durable.manifest.programId}@${durable.manifest.version}#${durable.manifest.digest}`;

function readiness(overrides: Partial<Parameters<typeof projectAvailableToolContracts>[1]> = {}) {
  return {
    ordinaryTools: new Set([ordinary.name]),
    drivers: new Set(["worker"]),
    programs: new Set([exactProgram]),
    effects: new Set<string>(),
    schemas: createDurableSchemaRegistry(durable.artifacts.catalog),
    durableDrivers: new Map([[durable.name, "worker"]]),
    ...overrides,
  };
}

describe("placement-aware tool availability", () => {
  it("exposes a durable contract only with complete exact placement", () => {
    expect(
      projectAvailableToolContracts([ordinary, durable], readiness()).map((tool) => tool.name),
    ).toEqual(["ordinary", "durable"]);
  });

  it.each([
    ["driver", { drivers: new Set<string>() }],
    ["program", { programs: new Set<string>() }],
    ["schema", { schemas: createDurableSchemaRegistry() }],
    ["binding", { durableDrivers: new Map<string, string>() }],
  ])(
    "omits and restores the durable contract when the exact %s placement is absent",
    (_name, gap) => {
      expect(
        projectAvailableToolContracts([ordinary, durable], readiness(gap)).map((tool) => tool.name),
      ).toEqual(["ordinary"]);
      expect(
        projectAvailableToolContracts([ordinary, durable], readiness()).map((tool) => tool.name),
      ).toEqual(["ordinary", "durable"]);
    },
  );
});
