
import { message } from './helper.js';

export function* review(title: string): Generator<string[], string, { ok: true; value: string } | { ok: false; error: string }> {
  'use workflow';
  try {
    const decision = yield ["effect", "scriptc.review.approval", message('approve:', title)];
    if (decision.ok) {
      return message('approved:', decision.value);
    } else {
      return message('rejected:', decision.error);
    }
  } finally {
    yield ["effect", "scriptc.review.cleanup", message('release:', title)];
  }
}
