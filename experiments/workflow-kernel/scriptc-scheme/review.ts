export function* review(title: string): Generator<string, string, string> {
  let reservation = title;
  const release = () => "release:" + reservation;
  try {
    const decision = yield "approve:" + title;
    reservation = decision;
    return "approved:" + decision;
  } finally {
    yield release();
  }
}
