/**
 * Style experiment for the missing composition primitive: an immutable,
 * named implementation catalog.
 *
 * A Registry stores what is available; it does not install a capability into a
 * scope, choose a value based on policy, or intercept invocation. Those are the
 * jobs of Port, Resolver, and middleware respectively.
 */

export interface Registry<T> {
  readonly name: string;
  /** Stable lexical order, suitable for deterministic catalogs and diagnostics. */
  readonly names: readonly string[];
  readonly size: number;
  has(name: string): boolean;
  get(name: string): T | undefined;
  require(name: string): T;
  entries(): readonly (readonly [string, T])[];
}

export class RegistryNameConflictError extends Error {
  readonly code = "registry_name_conflict";

  constructor(
    readonly registryName: string,
    readonly entryName: string,
  ) {
    super(`Registry "${registryName}" contains duplicate entry "${entryName}"`);
    this.name = "RegistryNameConflictError";
  }
}

export class RegistryEntryMissingError extends Error {
  readonly code = "registry_entry_missing";

  constructor(
    readonly registryName: string,
    readonly entryName: string,
  ) {
    super(`Registry "${registryName}" has no entry "${entryName}"`);
    this.name = "RegistryEntryMissingError";
  }
}

export function createRegistry<T>(
  registryName: string,
  entries: Iterable<readonly [string, T]>,
): Registry<T> {
  const values = new Map<string, T>();
  for (const [name, value] of entries) {
    if (values.has(name)) {
      throw new RegistryNameConflictError(registryName, name);
    }
    values.set(name, value);
  }

  const names = Object.freeze([...values.keys()].sort());
  const stableEntries = Object.freeze(
    names.map((name) => Object.freeze([name, values.get(name)!] as const)),
  );

  return Object.freeze({
    name: registryName,
    names,
    size: names.length,
    has(name: string): boolean {
      return values.has(name);
    },
    get(name: string): T | undefined {
      return values.get(name);
    },
    require(name: string): T {
      if (!values.has(name)) {
        throw new RegistryEntryMissingError(registryName, name);
      }
      return values.get(name)!;
    },
    entries(): readonly (readonly [string, T])[] {
      return stableEntries;
    },
  });
}
