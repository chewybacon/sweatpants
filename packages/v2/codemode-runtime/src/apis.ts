import type { Api } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { CodeValidator } from "./contracts.ts";

/** Select validation policy per operation. Replacement drivers and middleware are trusted;
 * a successful result grants no execution authority and owns no evaluator lifetime. */
export function createCodeValidator<Y>(
  runtime: Pick<Runtime<Y>, "composition">,
  name: string,
  driver: CodeValidator<NoInfer<Y>>,
): Api<CodeValidator<Y>, Y> {
  return runtime.composition.createApi<CodeValidator<Y>>(name, driver);
}
