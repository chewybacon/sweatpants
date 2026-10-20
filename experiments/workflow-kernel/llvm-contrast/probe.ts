function* review(title: string): Generator<string, string, string> {
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
const execution = review("draft");
console.log(JSON.stringify(execution.next("")));
console.log(JSON.stringify(execution.next("yes")));
console.log(JSON.stringify(execution.next("released")));
const cancelled = review("cancel");
console.log(JSON.stringify(cancelled.next("")));
console.log(JSON.stringify(cancelled.return("cancelled")));
console.log(JSON.stringify(cancelled.next("released")));
const repeated = review("repeat");
console.log(JSON.stringify(repeated.next("")));
console.log(JSON.stringify(repeated.return("cancelled")));
console.log(JSON.stringify(repeated.return("again")));
