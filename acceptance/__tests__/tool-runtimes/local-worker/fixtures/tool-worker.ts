import { runToolWorkerEntry } from "@sweatpants/tool-runtime-local/worker";
import { bookTrip } from "../../../../fixtures/book-trip.ts";
import { executionLocation } from "../../../../fixtures/execution-location.ts";

await runToolWorkerEntry([executionLocation, bookTrip]);
