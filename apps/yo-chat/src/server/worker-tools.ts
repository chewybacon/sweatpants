/**
 * yo-chat ordinary worker tool composition.
 *
 * The single authoritative list of ordinary tools that execute in the
 * ToolSession worker. The worker entry (`tool-worker.ts`) runs exactly this
 * list; the host composition (`tools.ts`) derives its ordinary inventory from
 * it. Crank-native durable programs (pick_card, play_ttt) never appear here —
 * they execute through the workflow host, not the ordinary worker.
 *
 * `composition.test.ts` enforces host/worker agreement.
 */
import { askQuestion } from "../tools/general/ask-question/tool";
import { bookFlightTool } from "../tools/book-flight/tool";
import { calculator } from "../tools/calculator";
import { tictactoeTool } from "../tools/tictactoe/tool";

export const workerTools = [askQuestion, bookFlightTool, calculator, tictactoeTool] as const;
