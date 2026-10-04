export interface ToolSessionModelSelection {
  readonly provider: string;
  readonly id: string;
}

export function modelSelectionFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ToolSessionModelSelection | undefined {
  const model = metadata?.["model"];
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return undefined;
  }
  const provider = (model as { provider?: unknown }).provider;
  const id = (model as { id?: unknown }).id;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return undefined;
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    return undefined;
  }
  return { provider: provider.trim(), id: id.trim() };
}
