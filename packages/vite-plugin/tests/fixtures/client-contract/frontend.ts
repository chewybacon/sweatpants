export function makePlugin<T>(tool: T): { readonly tool: T } {
  return { tool };
}
