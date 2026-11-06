import type { Operation } from 'effection';
import { message } from './helper.js';
import type { WorkflowContext } from '../contract.mjs';
export function* review(title: string, ctx: WorkflowContext): Operation<string> {
  'use workflow';
  let reservation = title;
  const release = () => message('release:', reservation);
  try {
    const decision = yield* ctx.elicit('approval', { message: message('approve:', title) });
    reservation = decision;
    return message('approved:', decision);
  } finally {
    yield* ctx.effect('cleanup', { message: release() });
  }
}
