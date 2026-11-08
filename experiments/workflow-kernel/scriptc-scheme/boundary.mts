import type { WorkflowModule } from "../../../packages/v2/codemode-compiler/src/index.ts";
import type { CapabilityRequest } from "../../../packages/v2/core/src/index.ts";

/** Assembly-owned capability ceiling. This does not install a handler or replace
 * the host's schema/admission checks. The artifact cannot supply its own allowlist.
 */
export function bindEffectBoundary(module: WorkflowModule, allowedEffects: readonly string[]) {
  const allowed = new Set(allowedEffects);
  const sites = new Map(
    Object.entries(module.effects).map(([site, declaration]) => {
      if (!allowed.has(declaration.effect)) {
        throw new Error(`Effect not granted: ${declaration.effect}`);
      }
      return [site, declaration.effect];
    }),
  );
  return (boundary: { site: string; value: unknown }): CapabilityRequest => {
    const effect = sites.get(boundary.site);
    const value = boundary.value;
    if (
      !effect ||
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== "effect" ||
      value[1] !== effect ||
      typeof value[2] !== "string"
    ) {
      throw new Error("Exchange does not match admitted effect");
    }
    return { effect, input: { message: value[2] } };
  };
}
