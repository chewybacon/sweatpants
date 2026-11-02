import { askQuestion } from "../tools/general/ask-question/tool";
import { bookFlightTool } from "../tools/book-flight/tool";
import { calculator } from "../tools/calculator";
import { tictactoeTool } from "../tools/tictactoe/tool";
import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";

/** The authored inventory shared by the app and its tool worker. */
export const tools = [
  askQuestion,
  bookFlightTool,
  calculator,
  pickCard,
  playTttTool,
  tictactoeTool,
] as const;
