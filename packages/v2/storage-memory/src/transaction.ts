/**
 * Process-local publication boundary. Read and decide synchronously; detach both
 * the proposed state and acknowledgement before publishing either. The decision
 * must not mutate current data or perform effects. publish must be a nonthrowing
 * assignment, not a callback that performs another transaction or external work.
 *
 * This stages one memory mutation, not a database or cross-process transaction.
 */
export function transactMemory<State, Result>(
  decide: () => { readonly state: State; readonly result: Result },
  publish: (state: State) => void,
): Result {
  const decision = decide();
  const state = structuredClone(decision.state);
  const result = structuredClone(decision.result);
  publish(state);
  return result;
}
