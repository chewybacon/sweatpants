export const acceptanceLanes = [
  { name: "memory", workers: 4 },
  { name: "sqlite", workers: 1 },
  { name: "process", workers: 1 },
] as const;

/** Bound each runner independently of pnpm's workspace concurrency. */
export function verificationEnvironment(workers = 1): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITEST_MAX_THREADS: String(workers),
    VITEST_MIN_THREADS: "1",
    VITEST_MAX_FORKS: String(workers),
    VITEST_MIN_FORKS: "1",
    // Bare `vitest` package scripts must finish rather than enter watch mode.
    CI: "1",
  };
}

export interface WorkspaceProject {
  name: string;
  directory: string;
  dependencies: string[];
  scripts: Record<string, string>;
}

export interface VerificationSelection {
  projects: WorkspaceProject[];
  broad: boolean;
  reasons: string[];
}

/** Unknown inputs require the complete gate; runtime imports aren't a sound test graph. */
export function selectVerification(
  projects: WorkspaceProject[],
  paths: string[],
  requested: string[] = [],
): VerificationSelection {
  const selected = new Set<string>();
  const reasons: string[] = [];
  for (const name of requested) {
    const project = projects.find((p) => p.name === name || p.directory === name);
    if (!project) {
      throw new Error(`Unknown workspace project: ${name}`);
    }
    selected.add(project.name);
  }
  for (const path of paths) {
    const project = projects.find((p) => path.startsWith(`${p.directory}/`));
    if (project) {
      selected.add(project.name);
    } else {
      reasons.push(`Shared or unmapped input: ${path}`);
    }
  }
  // Include transitive consumers: a change in a port must exercise its adapters.
  let previousSize = -1;
  while (previousSize !== selected.size) {
    previousSize = selected.size;
    for (const project of projects) {
      if (project.dependencies.some((name) => selected.has(name))) {
        selected.add(project.name);
      }
    }
  }
  return {
    projects: projects.filter((p) => selected.has(p.name)),
    broad: reasons.length > 0,
    reasons,
  };
}
