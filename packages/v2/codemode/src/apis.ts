import type { Api } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { CodeAuthoring } from "./contracts.ts";

/** Scoped authoring guidance. Middleware selects instructions per call; this facade
 * owns no model task, catalog permissions, execution or recovery loop. */
export function createCodeAuthoring<Y>(
  runtime: Pick<Runtime<Y>, "composition">,
  name: string,
  driver: CodeAuthoring<NoInfer<Y>>,
): Api<CodeAuthoring<Y>, Y> {
  return runtime.composition.createApi<CodeAuthoring<Y>>(name, driver);
}
