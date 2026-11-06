import { z } from "zod";
import { defineTool, type ToolDefinition } from "../../../packages/v2/tools/src/index.ts";
import { sample, sampleSchema, move, prompt } from "./contracts.mts";

const valid = (value: string) => ["rock", "paper", "scissors"].includes(value);
function winner(machine: string, player: string) {
  return machine === player
    ? "tie"
    : (machine === "rock" && player === "paper") ||
        (machine === "paper" && player === "scissors") ||
        (machine === "scissors" && player === "rock")
      ? "player"
      : "model";
}
/** Same effect declaration and Outcome shape as Scheme, through existing ToolContext. */
const roundsSchema = z.number().int().min(1).max(3);
export const rpsTool: ToolDefinition<
  typeof roundsSchema,
  { sample: typeof sample },
  { move: typeof move },
  string
> = defineTool("experiment.rps-tool/1")
  .parameters(roundsSchema)
  .capabilities({ sample })
  .elicits({ move })
  .execute(function* (rounds, ctx) {
    let result = "";
    for (let remaining = rounds; remaining > 0; remaining--) {
      const sampled = yield* ctx.capabilities.sample({ prompt: prompt + remaining });
      if (!sampled.ok) {
        return result + "sample rejected";
      }
      const machine = sampled.value.text;
      if (!valid(machine)) {
        return result + "invalid model move";
      }
      const answer = yield* ctx.elicit("move", {
        message: "Choose rock, paper, or scissors. Round " + remaining,
      });
      if (!answer.ok) {
        return result + "player declined";
      }
      result += winner(machine, answer.value) + ";";
    }
    return result;
  });

const schemeWinner = `(define (winner machine player)
  (if (equal? machine player) "tie"
    (if (equal? machine "rock") (if (equal? player "paper") "player" "model")
      (if (equal? machine "paper") (if (equal? player "scissors") "player" "model")
        (if (equal? player "rock") "player" "model")))))`;

// A bounded loop expressed with ordinary Scheme recursion. The sample is requested
// before eliciting a move; it receives no player answer or implicit outer history.
export const gameCaller = `
(define (valid move)
  (if (equal? move "rock") #t (if (equal? move "paper") #t (equal? move "scissors"))))
${schemeWinner}
(define (play remaining)
  (if (equal? remaining 0) ""
    (let ((sampled (sample (object (list "prompt" (js-add ${JSON.stringify(prompt)} remaining))))))
      (if (json-field sampled "ok")
        (let ((machine (json-field (json-field sampled "value") "text")))
          (if (valid machine)
            (let ((answer (elicit (object (list "message" (js-add "Choose rock, paper, or scissors. Round " remaining))))))
              (if (json-field answer "ok")
                (string-append (winner machine (json-field answer "value")) ";" (play (js-add remaining -1)))
                "player declined"))
            "invalid model move"))
        "sample rejected"))))
(play %input)`;

/** A second consumer: validated move plus explanation, then a participant wait. */
export const structuredTool: ToolDefinition<
  typeof roundsSchema,
  { sampleSchema: typeof sampleSchema },
  { move: typeof move },
  string
> = defineTool("experiment.structured-rps/1")
  .parameters(roundsSchema)
  .capabilities({ sampleSchema })
  .elicits({ move })
  .execute(function* (_rounds, ctx) {
    const sampled = yield* ctx.capabilities.sampleSchema({
      prompt: "Choose a move and explain it briefly.",
    });
    if (!sampled.ok) {
      return "sample rejected";
    }
    if (!sampled.value.valid) {
      return sampled.value.reason;
    }
    const plan = sampled.value.value;
    const answer = yield* ctx.elicit("move", { message: plan.reason });
    return answer.ok ? winner(plan.move, answer.value) : "player declined";
  });

export const structuredCaller = `
${schemeWinner}
(let ((sampled (sampleSchema (object (list "prompt" "Choose a move and explain it briefly.")))))
  (if (json-field sampled "ok")
    (let ((result (json-field sampled "value")))
      (if (json-field result "valid")
        (let ((plan (json-field result "value")))
          (let ((answer (elicit (object (list "message" (json-field plan "reason"))))))
            (if (json-field answer "ok")
              (winner (json-field plan "move") (json-field answer "value"))
              "player declined")))
        (json-field result "reason")))
    "sample rejected"))`;
