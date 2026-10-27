import { writeFileSync } from "node:fs";
import { suspend } from "effection";
import { serveWorkerGuest } from "@sweatpants/tool-runtime-local/worker";

serveWorkerGuest(function* ({ started, closed }: { started: string; closed: string }) {
  try {
    writeFileSync(started, "acquiring");
    yield* suspend();
    throw new Error("Acquisition resumed unexpectedly");
  } finally {
    writeFileSync(closed, "disposed");
  }
});
