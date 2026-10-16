import { run, scoped } from "effection";
import { parseDSL } from "@tisyn/dsl";
import { createEvaluation, TisynEvaluationPort } from "../../port.ts";
import { createNodeEvaluationDriver } from "../../node.ts";

const report = await run(function* () {
  yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
  let failure: string | undefined;
  try {
    yield* scoped(function* () {
      const evaluator = yield* createEvaluation(parseDSL(process.argv[2]));
      yield* evaluator.next();
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const evaluator = yield* createEvaluation(parseDSL("Add(20,22)"));
  const subsequent = yield* evaluator.next();
  return { failure, subsequent };
});
console.log(JSON.stringify(report));
