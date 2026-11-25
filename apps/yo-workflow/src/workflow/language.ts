export type WorkflowLanguage = "scheme" | "lua" | "python";
export function workflowLanguage(value: string | null): WorkflowLanguage {
  if (value === null || value === "scheme") {
    return "scheme";
  }
  if (value === "lua" || value === "python") {
    return value;
  }
  throw new Error(`Unavailable workflow language: ${value}`);
}
