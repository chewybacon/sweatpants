// Adapter implementation helpers; not part of the application composition contract.
export type MemberKind = "method" | "property";
export type RawInvoke = (...args: unknown[]) => unknown;
export type RawDecorator = (next: RawInvoke) => RawInvoke;
export type RawDefinition = { readonly operations?: object; readonly sync?: object };

export function describeSync(members: object = {}) {
  if (Object.getOwnPropertySymbols(members).length) {
    throw new TypeError("API members must have string keys");
  }
  const kinds = new Map<string, MemberKind>();
  for (const key of Object.keys(members)) {
    const descriptor = Object.getOwnPropertyDescriptor(members, key)!;
    if (descriptor.set) {
      throw new TypeError("API properties must be read-only");
    }
    kinds.set(key, typeof descriptor.value === "function" ? "method" : "property");
  }
  return kinds;
}

/** Injective group/name encoding keeps internal API contexts disjoint. */
export function apiKey(name: string, group: "operations" | "sync" | "driver") {
  return JSON.stringify(["standard-durability-api", group, name]);
}

export function mergeDriver(current: RawDefinition, driver: RawDefinition): RawDefinition {
  return { operations: driver.operations ?? current.operations, sync: driver.sync ?? current.sync };
}

export function assertSynchronous<T>(value: T): T {
  if (value && (typeof value === "object" || typeof value === "function")) {
    if ("then" in value && typeof value.then === "function") {
      void Promise.resolve(value).catch(() => undefined);
      throw new TypeError("Synchronous API member returned a Promise");
    }
    if (
      Symbol.iterator in value &&
      !Array.isArray(value) &&
      !(value instanceof Map) &&
      !(value instanceof Set) &&
      !ArrayBuffer.isView(value)
    ) {
      throw new TypeError("Synchronous API member returned an operation or unsupported iterable");
    }
  }
  return value;
}

export function readMember(target: object, key: string, args: unknown[], kind: MemberKind) {
  const member: unknown = Reflect.get(target, key);
  return kind === "property" ? member : Reflect.apply(member as RawInvoke, target, args);
}

/** Guard both the decorator boundary and each synchronous invocation. */
export function synchronousDecorator(decorate: RawDecorator): RawDecorator {
  return (next) => {
    const wrapped = decorate((...args) => assertSynchronous(next(...args)));
    if (typeof wrapped !== "function") {
      throw new TypeError("API decorator must return a callable");
    }
    return (...args) => assertSynchronous(wrapped(...args));
  };
}

export function bindMembers(
  members: ReadonlyMap<string, MemberKind>,
  invoke: (key: string, args: unknown[]) => unknown,
) {
  const bound: Record<string, unknown> = {};
  for (const [key, kind] of members) {
    Object.defineProperty(
      bound,
      key,
      kind === "property"
        ? { enumerable: true, get: () => invoke(key, []) }
        : { enumerable: true, value: (...args: unknown[]) => invoke(key, args) },
    );
  }
  return Object.freeze(bound);
}
