/**
 * Worker entry for the acceptance fixture tool.
 *
 * Mirrors the framework-generated tool worker: it imports the SAME authored
 * tool and invokes its real execute generator through the contract protocol.
 * There is exactly one implementation of acceptance_booking.
 */
import { runToolWorkerEntry } from "@sweatpants/tool-runtime-local/worker";
import { acceptanceBookingTool } from "./acceptance-booking.tool.ts";
import { acceptanceImmediateTool } from "./acceptance-immediate.tool.ts";

await runToolWorkerEntry([acceptanceBookingTool, acceptanceImmediateTool]);
