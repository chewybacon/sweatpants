
import { message } from './helper.js';

export function* review(title: string): Generator<string[], string, string> {
  'use workflow';
  let reservation = title;
  const release = () => message('release:', reservation);
  try {
    const decision = yield ["effect", "scriptc.review.approval", message('approve:', title)];
    reservation = decision;
    return message('approved:', decision);
  } finally {
    yield ["effect", "scriptc.review.cleanup", release()];
  }
}
