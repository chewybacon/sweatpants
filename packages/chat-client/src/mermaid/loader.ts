import { call, type Operation } from "effection";
import type MermaidModule from "mermaid";
type Mermaid = typeof MermaidModule;
let mermaid: Mermaid | undefined;
let loading: Promise<Mermaid> | undefined;

let idCounter = 0;
const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

async function initializeMermaid(): Promise<Mermaid | null> {
  if (!isBrowser) {
    return null;
  }
  loading ??= import("mermaid")
    .then(({ default: module }) => {
      module.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        flowchart: { htmlLabels: true, curve: "basis" },
        sequence: { diagramMarginX: 10, diagramMarginY: 10 },
        themeVariables: {
          primaryColor: "#3b82f6",
          primaryTextColor: "#f8fafc",
          primaryBorderColor: "#60a5fa",
          lineColor: "#94a3b8",
          secondaryColor: "#1e293b",
          tertiaryColor: "#334155",
          background: "#0f172a",
          mainBkg: "#1e293b",
          nodeBorder: "#60a5fa",
          clusterBkg: "#1e293b",
          clusterBorder: "#475569",
          titleColor: "#f8fafc",
          edgeLabelBackground: "#1e293b",
        },
      });
      mermaid = module;
      return module;
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

export function isMermaidReady(): boolean {
  return !isBrowser || mermaid !== undefined;
}

export function preloadMermaid(): Operation<void> {
  return call(async () => {
    await initializeMermaid();
  });
}

export type MermaidRenderResult =
  | { success: true; svg: string }
  | { success: false; error: string };

export function renderMermaid(code: string): Operation<MermaidRenderResult> {
  return call(async () => {
    try {
      const module = await initializeMermaid();
      if (!module) {
        return { success: false, error: "Mermaid requires browser environment" };
      }
      const id = `mermaid-${++idCounter}`;
      const isValid = await module.parse(code, { suppressErrors: true });
      if (!isValid) {
        return { success: false, error: "Invalid mermaid syntax" };
      }
      const { svg } = await module.render(id, code);
      return { success: true, svg: `<div class="mermaid-diagram">${svg}</div>` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });
}
