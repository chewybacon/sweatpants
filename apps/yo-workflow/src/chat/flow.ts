export interface FlowNode {
  id: string;
  kind: "yield" | "branch" | "exit" | "call" | "entry";
  title: string;
  detail: string;
  caption?: string;
  origin?: "builtin" | "authored";
}
export interface FlowEdge {
  source: string;
  target: string;
  label?: string;
}
