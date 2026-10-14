// Shared probe: the same dynamically evaluated programs run in Node and workerd.
export async function scenarios(load) {
  function safeInteger(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('Integer exceeds JSON safe range');
    return number;
  }
  const rawLoad = load;
  load = async () => (await rawLoad()).map(proc => ({
    call: (...args) => proc.call(...args.map(value => Number.isSafeInteger(value) ? BigInt(value) : value)).map(value =>
      typeof value === 'bigint' ? safeInteger(value) :
      value?.constructor?.name === 'MutableString' ? value.reflector.string_value(value) : value)
  }));
  const results = [];
  function equal(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
    results.push(label);
  }
  const source = `(let ((n (effect "random" "1..6")))
    (let ((answer (effect "ask" "Your name?")))
      (string-append answer ":" (number->string n))))`;
  let [start, next] = await load();
  equal(start.call(source), ['effect', 'random', '1..6'], 'yield random');
  // Stand-in for the host journal, deliberately outside the WASM instance.
  const journal = [{ effect: ['effect', 'random', '1..6'], result: 4 }];
  equal(next.call(journal[0].result), ['effect', 'ask', 'Your name?'], 'resume into ask');
  start = next = null; // Drop every procedure handle; no continuation is serialized.
  [start, next] = await load();
  let step = start.call(source);
  for (const entry of JSON.parse(JSON.stringify(journal))) {
    equal(step, entry.effect, 'replay descriptor matches');
    step = next.call(entry.result);
  }
  equal(step, ['effect', 'ask', 'Your name?'], 'fresh instance restores pending ask');
  equal(next.call('Ada'), ['done', 'Ada:4'], 'answer resumes to final value');
  const [tail] = await load();
  equal(tail.call('(let loop ((n 100000) (acc 0)) (if (= n 0) acc (loop (- n 1) (+ acc 1))))'),
    ['done', 100000], '100000 interpreted tail calls');
  const [macro, resumeMacro] = await load();
  equal(macro.call(`(let-syntax ((ask (syntax-rules () ((_ message) (effect "ask" message)))))
    (ask "Macro question"))`), ['effect', 'ask', 'Macro question'], 'authored syntax-rules macro yields');
  equal(resumeMacro.call('yes'), ['done', 'yes'], 'macro continuation resumes');
  return { passed: results, journal, limitations: ['Harness journal, not Sweatpants integration',
    'No static types', 'No instruction fuel or restricted evaluation environment yet'] };
}
