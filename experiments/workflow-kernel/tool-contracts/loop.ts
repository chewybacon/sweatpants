import { createDurableTool, type DurableProgramContextFor } from '@sweatpants/agent-sdk';
import { z } from 'zod';
const exchanges = {
  move: { response: z.string() },
  cleanup: { response: z.string() },
};
type Context = DurableProgramContextFor<{}, typeof exchanges, false>;
function* turn(ctx: Context, round: number) {
  "use workflow";
  const answer = yield* ctx.elicit('move', { message: 'Round ' + round });
  return answer.action;
}
export const game = createDurableTool('repeating-game', { version: '1' })
  .description('Repeat a turn until declined')
  .parameters(z.strictObject({ limit: z.number().int().min(0) }))
  .output(z.strictObject({ rounds: z.number(), score: z.number() }))
  .elicits(exchanges)
  .execute(function* (input, ctx) {
    "use workflow";
    let rounds = 0;
    let score = 0;
    while (rounds < input.limit) {
      rounds = rounds + 1;
      try {
        const action = yield* turn(ctx, rounds);
        if (action === 'decline') break;
        if (action === 'cancel') continue;
        score = score + 1;
      } finally {
        yield* ctx.elicit('cleanup', { message: 'Finished ' + rounds });
      }
    }
    return { rounds, score };
  });
