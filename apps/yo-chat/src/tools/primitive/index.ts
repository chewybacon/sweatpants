import { calculator } from "./calculator";
import { askQuestion } from "./ask-question";
import { pickCard } from "./pick-card";
import { bookFlightTool } from "./book-flight";
import { playTttTool } from "./play-ttt";
import { tictactoeTool } from "./tictactoe";
export const localJournalTools = [
  calculator,
  askQuestion,
  pickCard,
  bookFlightTool,
  playTttTool,
  tictactoeTool,
] as const;
