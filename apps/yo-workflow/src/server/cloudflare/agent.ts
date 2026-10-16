import { decisionBinding } from "../../workflow/decisions.ts";
import { sha256 } from "@sweatpants/foundation";
import kernelBundle from "../../workflow/evaluation/generated/kernel-source.json" with { type: "json" };
import packageJson from "../../../package.json" with { type: "json" };
import { boundTools, scheme } from "../../workflow/agent.ts";
import { createTisynTool, type BoundTool } from "../../workflow/tisyn.ts";
import { QUICKJS_LIMITS } from "../../workflow/evaluation/quickjs.ts";

const builder = createTisynTool(boundTools, {
  id: `yo-workflow@0.0.1/profile-6-quickjs-${packageJson.dependencies["quickjs-emscripten-core"]}-${packageJson.dependencies["@jitl/quickjs-wasmfile-release-sync"]}/${sha256(kernelBundle.kernelSource)}/${kernelBundle.provenance.source?.fingerprint ?? "published"}`,
  limits: QUICKJS_LIMITS,
  description: `Limits: ${QUICKJS_LIMITS.toolCalls} tool calls per program; ${QUICKJS_LIMITS.interruptChecks} QuickJS interrupt checks per synchronous advance; 32 MiB VM memory; ${QUICKJS_LIMITS.stackBytes / 1024} KiB VM stack. Human wait time is excluded. Limits fail explicitly, not as successful completion. This is not a wall-clock deadline.`,
});
export const tisyn = builder.samples().decisions(decisionBinding).build();
export const programs: readonly BoundTool[] = [scheme, tisyn, ...boundTools];
