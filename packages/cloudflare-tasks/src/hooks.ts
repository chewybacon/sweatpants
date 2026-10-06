export function resolve(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (specifier: string, context: { parentURL?: string }) => unknown,
): unknown {
  if (specifier === "cloudflare:workers") {
    return { shortCircuit: true, url: new URL("./bindings.js", import.meta.url).href };
  }
  return nextResolve(specifier, context);
}
