import { runToolWorkerEntry } from "@sweatpants/tool-runtime-local/worker";
import { bookTrip } from "../../../../fixtures/book-trip.ts";
import { executionLocation } from "../../../../fixtures/execution-location.ts";

import { confirmedTrip } from "../../../../fixtures/confirmed-trip.ts";

import { echoTool, strictEcho, exitWorker } from "../../../../fixtures/echo-tool.ts";

import { workerContext } from "../../../../fixtures/worker-context.ts";

await runToolWorkerEntry([
  workerContext,
  echoTool,
  strictEcho,
  exitWorker,
  executionLocation,
  bookTrip,
  confirmedTrip,
]);
