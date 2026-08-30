import { run, scoped } from "effection";
import { describe, expect, it } from "vitest";
import { defineResolver } from "../resolver-style.ts";

interface ResolutionRequest {
  readonly value: string;
  readonly parentRoute: string;
}

const fallbackResolver = defineResolver<ResolutionRequest, string>(
  "resolver-style-fallback",
  function* (input) {
    return input.parentRoute;
  },
);

const requiredResolver = defineResolver<ResolutionRequest, string>("resolver-style-required");

const implementation = (label: string) =>
  function* (input: ResolutionRequest) {
    return `${label}:${input.value}`;
  };

describe("generic resolver style", () => {
  it("uses a domain-provided fallback when no implementation is installed", async () => {
    await run(function* () {
      const resolver = yield* fallbackResolver.use();
      expect(yield* resolver.resolve({ value: "child", parentRoute: "parent" })).toBe("parent");
    });
  });

  it("fails closed when no implementation or fallback is installed", async () => {
    await expect(
      run(function* () {
        const resolver = yield* requiredResolver.use();
        yield* resolver.resolve({ value: "child", parentRoute: "parent" });
      }),
    ).rejects.toMatchObject({ code: "resolver_unavailable" });
  });

  it("composes outer and inner middleware around the selected implementation", async () => {
    const log: string[] = [];
    const resolver = defineResolver<ResolutionRequest, string>("resolver-style-layered");

    await run(function* () {
      yield* resolver.api.around({
        *resolve([input], next) {
          log.push(`outer-before:${input.value}`);
          const result = yield* next(input);
          log.push(`outer-after:${result}`);
          return result;
        },
      });

      yield* scoped(function* () {
        yield* resolver.install(implementation("driver"));
        yield* scoped(function* () {
          const facade = yield* resolver.use();
          yield* facade.around({
            *resolve([input], next) {
              log.push(`inner-before:${input.value}`);
              const result = yield* next(input);
              log.push(`inner-after:${result}`);
              return result;
            },
          });

          expect(yield* facade.resolve({ value: "child", parentRoute: "parent" })).toBe(
            "driver:child",
          );
        });
      });
    });

    expect(log).toEqual([
      "outer-before:child",
      "inner-before:child",
      "inner-after:driver:child",
      "outer-after:driver:child",
    ]);
  });

  it("supports middleware installed before the implementation", async () => {
    const log: string[] = [];
    const resolver = defineResolver<ResolutionRequest, string>("resolver-style-before");

    await run(function* () {
      yield* resolver.api.around({
        *resolve([input], next) {
          log.push(`observed:${input.value}`);
          return yield* next(input);
        },
      });
      yield* resolver.install(implementation("driver"));

      const facade = yield* resolver.use();
      expect(yield* facade.resolve({ value: "child", parentRoute: "parent" })).toBe("driver:child");
    });

    expect(log).toEqual(["observed:child"]);
  });

  it("supports short-circuit policy middleware without calling next", async () => {
    const resolver = defineResolver<ResolutionRequest, string>("resolver-style-policy");

    await run(function* () {
      yield* resolver.install(implementation("driver"));
      const facade = yield* resolver.use();
      yield* facade.around({
        *resolve([input], _next) {
          if (input.value === "blocked") return "policy-route";
          throw new Error("unexpected next call in this fixture");
        },
      });

      expect(yield* facade.resolve({ value: "blocked", parentRoute: "parent" })).toBe(
        "policy-route",
      );
    });
  });

  it("keeps one facade dynamic across child implementation scopes", async () => {
    const resolver = defineResolver<ResolutionRequest, string>("resolver-style-scopes");

    await run(function* () {
      yield* resolver.install(implementation("outer"));
      const facade = yield* resolver.use();

      yield* scoped(function* () {
        yield* resolver.install(implementation("inner"));
        expect(yield* resolver.use()).toBe(facade);
        expect(yield* facade.resolve({ value: "child", parentRoute: "parent" })).toBe(
          "inner:child",
        );
      });

      expect(yield* facade.resolve({ value: "child", parentRoute: "parent" })).toBe("outer:child");
    });
  });
});
