import type { RedisClientType } from "redis";

/**
 * Minimal deterministic Redis command surface for package conformance tests.
 * It implements the exact GET/SET/SETNX/SET-membership/CAS Lua semantics used
 * by this package, so tests never silently skip when a system Redis daemon is
 * unavailable. Real Redis remains selectable through REDIS_URL.
 */
export function createMemoryRedisClient(): RedisClientType {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const client = {
    isOpen: true,
    async connect() {},
    async ping() {
      return "PONG";
    },
    async disconnect() {
      client.isOpen = false;
    },
    async quit() {
      client.isOpen = false;
    },
    async get(key: string) {
      return strings.get(key) ?? null;
    },
    async set(key: string, value: string) {
      strings.set(key, value);
      return "OK";
    },
    async setNX(key: string, value: string) {
      if (strings.has(key)) {
        return false;
      }
      strings.set(key, value);
      return true;
    },
    async sMembers(key: string) {
      return [...(sets.get(key) ?? new Set<string>())];
    },
    async keys(pattern: string) {
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
      return [...new Set([...strings.keys(), ...sets.keys()])].filter((key) =>
        pattern.endsWith("*") ? key.startsWith(prefix) : key === pattern,
      );
    },
    async del(keys: string | string[]) {
      const selected = Array.isArray(keys) ? keys : [keys];
      let removed = 0;
      for (const key of selected) {
        if (strings.delete(key)) {
          removed += 1;
        }
        if (sets.delete(key)) {
          removed += 1;
        }
      }
      return removed;
    },
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      const [stateKey, runnableKey] = options.keys;
      const [expected, next, sessionId, keepRunnable] = options.arguments;
      if (!stateKey || expected === undefined || next === undefined) {
        return 0;
      }
      if ((strings.get(stateKey) ?? "") !== expected) {
        return 0;
      }
      if (script.includes("SWEATPANTS_EXECUTION_STORE_V1")) {
        const segmentKeys = options.keys.slice(1);
        const segmentValues = options.arguments.slice(2);
        if (segmentKeys.length !== segmentValues.length) {
          return 0;
        }
        for (let index = 0; index < segmentKeys.length; index += 1) {
          const key = segmentKeys[index]!;
          const value = segmentValues[index]!;
          const existing = strings.get(key);
          if (existing !== undefined && existing !== value) {
            return -1;
          }
        }
        for (let index = 0; index < segmentKeys.length; index += 1) {
          strings.set(segmentKeys[index]!, segmentValues[index]!);
        }
        strings.set(stateKey, next);
        return 1;
      }
      strings.set(stateKey, next);
      if (runnableKey && sessionId) {
        const runnable = sets.get(runnableKey) ?? new Set<string>();
        if (keepRunnable === "1") {
          runnable.add(sessionId);
        } else {
          runnable.delete(sessionId);
        }
        sets.set(runnableKey, runnable);
      }
      return 1;
    },
    duplicate() {
      return client;
    },
    async subscribe() {},
    async unsubscribe() {},
  };

  return client as unknown as RedisClientType;
}
