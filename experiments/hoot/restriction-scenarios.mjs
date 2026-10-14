import { scenarios } from './scenarios.mjs';
export async function restrictionScenarios(load) {
  const normal = await scenarios(load);
  normal.limitations = ['Harness journal, not Sweatpants integration', 'No static types',
    'Fuel is function/loop-entry accounting, not a CPU or heap byte limit'];
  const rejected = [];
  const attacks = {
    'filesystem': '(open-input-file "/etc/passwd")',
    'fuel access': '(set! __fuel 1000000000)',
    'eval': '(eval \'(+ 1 2) (interaction-environment))',
    'module lookup': '((@ (hoot modules) module-ref) ((@ (hoot modules) the-root-module)) \'x)',
    'private module lookup': '(@@ (hoot user) effect)',
    'import': '(begin (import (scheme file)) (file-exists? "/etc/passwd"))',
    'load': '(load "anything.scm")',
    'FFI': '(procedure->external (lambda () 1))',
    'unauthorized effect': '(effect "fetch" "https://example.com")',
    'bad effect payload': '(effect "ask" (lambda () 1))',
    'macro capability escape': '(let-syntax ((escape (syntax-rules () ((_) (open-input-file "/etc/passwd"))))) (escape))',
  };
  for (const [name, source] of Object.entries(attacks)) {
    const program = await load();
    program.fuel.value = 1000000n;
    let blocked = false;
    let failure;
    try { program[0].call(source); } catch (error) {
      failure = {name: error.constructor.name, message: String(error), fuel: String(program.fuel.value)};
      blocked = error.constructor.name === "SchemeQuitError" && program.fuel.value > 0n;
    }
    if (!blocked) throw new Error(`Capability check failed: ${name}: ${JSON.stringify(failure)}`);
    rejected.push(name);
  }
  const exhausted = [];
  for (const [name, source] of Object.entries({
    'infinite recursion': '(let loop () (loop))',
    'infinite macro expansion': '(let-syntax ((again (syntax-rules () ((_) (again))))) (again))',
    'allocation loop': '(let loop ((xs (quote ()))) (loop (cons 1 xs)))',
  })) {
    const program = await load();
    program.fuel.value = 20000n;
    let trapped = false;
    try { program[0].call(source); } catch (e) {
      trapped = e instanceof WebAssembly.RuntimeError && program.fuel.value < 0n;
    }
    if (!trapped) throw new Error(`No fuel trap: ${name}`);
    exhausted.push({name, remaining: String(program.fuel.value)});
    // Trapped instances are discarded, never resumed.
  }
  const resumed = await load();
  resumed.fuel.value = 1000000n;
  const pending = resumed[0].call('(begin (effect "ask" "Continue?") (let loop () (loop)))');
  if (pending[0] !== 'effect') throw new Error('Expected suspension before runaway continuation');
  resumed.fuel.value = 20000n;
  let resumeTrapped = false;
  try { resumed[1].call('yes'); } catch (error) {
    resumeTrapped = error instanceof WebAssembly.RuntimeError && resumed.fuel.value < 0n;
  }
  if (!resumeTrapped) throw new Error('Continuation escaped fuel budget');
  exhausted.push({name: 'runaway after resume', remaining: String(resumed.fuel.value)});
  const fresh = await load();
  fresh.fuel.value = 200000n;
  const result = fresh[0].call('(+ 20 22)');
  if (result[0] !== 'done' || Number(result[1]) !== 42) throw new Error('Fresh instance failed after exhaustion');
  return {normal, rejected, exhausted, healthyAfterTrap: true};
}
