import type { WorkflowModule } from "../../../packages/v2/codemode-compiler/src/index.ts";
import type { CapabilityRequest } from "../../../packages/v2/core/src/index.ts";
import { luaWorkflowLinker } from "@sweatpan.ts/codemode-compiler-lua/link";
import { bindEffectBoundary } from "./boundary.mts";
export { luaWorkflowLinker };
export function linkLuaReview(options: {
  module: WorkflowModule;
  caller: string;
  identity: string;
}) {
  return luaWorkflowLinker.link({
    ...options,
    name: "review_draft",
    caller: { language: "lua", text: options.caller },
  });
}
export function bindLuaReviewBoundary(
  module: WorkflowModule,
  allowed: readonly string[],
): (boundary: unknown) => CapabilityRequest {
  const decode = bindEffectBoundary(module, allowed);
  return (boundary: unknown) => {
    if (
      !boundary ||
      typeof boundary !== "object" ||
      !("site" in boundary) ||
      typeof boundary.site !== "string" ||
      !("request" in boundary)
    ) {
      throw new Error("Malformed Lua workflow exchange");
    }
    return decode({ site: boundary.site, value: boundary.request });
  };
}
