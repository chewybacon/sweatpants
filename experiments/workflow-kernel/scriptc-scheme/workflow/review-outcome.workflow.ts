import type { Operation } from 'effection';
import { message } from './helper.js';
import type { WorkflowContext } from '../contract.mjs';
export function* review(title: string, ctx: WorkflowContext): Operation<string> {
  'use workflow';
  try {
    const decision = yield* ctx.elicit('approval', { message: message('approve:', title) });
    if (decision.ok) {
      return message('approved:', decision.value);
    } else {
      return message('rejected:', decision.error);
    }
  } finally {
    yield* ctx.effect('cleanup', { message: message('release:', title) });
  }
}
