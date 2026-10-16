/** Shared by local launchers and both server adapters. */
export function reasoningLevel(value = "medium") {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      throw new Error(
        `Unsupported reasoning level: ${value}. Use off, minimal, low, medium, high, or xhigh.`,
      );
  }
}
