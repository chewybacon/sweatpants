export type WorkflowLanguage = "scheme" | "lua";
export function workflowLanguage(value: string | null): WorkflowLanguage {
  if (value === null || value === "scheme") {
    return "scheme";
  }
  if (value === "lua") {
    return "lua";
  }
  throw new Error(`Unavailable workflow language: ${value}`);
}
