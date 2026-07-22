import { runToolWorkerEntry } from "@sweatpants/tool-runtime-local/worker";
import { reactBookingTool } from "./react-booking.tool.ts";

await runToolWorkerEntry([reactBookingTool]);
