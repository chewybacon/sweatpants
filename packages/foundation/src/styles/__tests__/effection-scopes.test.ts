/**
 * Living reference for native Effection (4.2.0 when introduced).
 * Read ownership -> shutdown -> middleware -> interception.
 * Gates observe lifecycle events without relying on sleeps. On upgrades,
 * investigate trace changes instead of automatically refreshing expectations.
 * Suppressing destroy is deliberately NOT presented as durable parking.
 *
 * Run: pnpm -C packages/foundation exec vitest run
 *      src/styles/__tests__/effection-scopes.test.ts
 * Related: styles.test.ts compares port shapes; ../../__tests__/port.test.ts
 * exercises the shipped definePort facade.
 *
 * Findings pinned below:
 * - max/default: earlier/ancestor middleware wraps later/descendant middleware.
 * - min: later/descendant middleware wraps earlier/ancestor middleware.
 * - max wraps min; terminal drivers at min preserve max observation.
 * - explicit scoped return can defer resource destruction, but its body is done.
 * - task halt also drains a TaskGroup; Scope.destroy suppression cannot veto it.
 * - useAbortSignal is itself a resource: cleanup observes registration ordering.
 * - last executed cleanup failure wins (the compiler spike must reconcile this).
 * - yielding native finally limitations are characterization tests, not desired
 *   semantics. Re-evaluate their assertions when the upstream bugs are fixed.
 */
import {
  createScope,
  ensure,
  run,
  scoped,
  spawn,
  suspend,
  useAbortSignal,
  useScope,
  withResolvers,
  type Operation,
  type Scope,
} from "effection";
import { api, createApi } from "effection/experimental";
import { describe, expect, it } from "vitest";

// Mechanical recorder only; each test owns its ordering assertions.
function observe(log: string[], name: string) {
  return {
    *ping(args: [], next: () => Operation<string>): Operation<string> {
      log.push(`${name}:in`);
      const value = yield* next(...args);
      log.push(`${name}:out`);
      return value;
    },
  };
}
function probe(log: string[]) {
  return createApi("scope-reference-probe", {
    *ping(): Operation<string> {
      log.push("core");
      return "ok";
    },
  });
}

describe("Effection reference: ownership and shutdown", () => {
  it("plain delegation and while blocks share the owner; ensures are LIFO", async () => {
    const log: string[] = [];
    await run(function* () {
      const owner = yield* useScope();
      function* helper(n: number) {
        expect(yield* useScope()).toBe(owner);
        yield* ensure(() => {
          log.push(`release:${n}`);
        });
      }
      let n = 0;
      while (n < 3) {
        yield* helper(++n);
      }
      expect(log).toEqual([]);
      log.push("body:done");
    });
    expect(log).toEqual(["body:done", "release:3", "release:2", "release:1"]);
  });
  it("scoped creates a distinct owner and drains cleanup before returning", async () => {
    const log: string[] = [];
    await run(function* () {
      const parent = yield* useScope();
      yield* ensure(() => {
        log.push("parent:cleanup");
      });
      for (let n = 1; n <= 2; n++) {
        const value = yield* scoped(function* () {
          expect(yield* useScope()).not.toBe(parent);
          log.push(`acquire:${n}`);
          yield* ensure(() => {
            log.push(`release:${n}`);
          });
          return n;
        });
        expect(value).toBe(n);
        expect(yield* useScope()).toBe(parent);
        log.push(`after:${n}`);
      }
    });
    expect(log).toEqual([
      "acquire:1",
      "release:1",
      "after:1",
      "acquire:2",
      "release:2",
      "after:2",
      "parent:cleanup",
    ]);
  });
  it("suspending does not trigger ensure; halting does", async () => {
    const ready = withResolvers<void>(),
      log: string[] = [];
    const task = run(function* () {
      yield* ensure(() => {
        log.push("cleanup");
      });
      ready.resolve();
      yield* suspend();
    });
    try {
      await run(() => ready.operation);
      expect(log).toEqual([]);
    } finally {
      await task.halt();
    }
    expect(log).toEqual(["cleanup"]);
  });
  it("halting a spawned child drains it while the parent continues", async () => {
    const log: string[] = [];
    await run(function* () {
      const ready = withResolvers<void>();
      yield* ensure(() => {
        log.push("parent:cleanup");
      });
      const child = yield* spawn(function* () {
        yield* ensure(() => {
          log.push("child:cleanup");
        });
        ready.resolve();
        yield* suspend();
      });
      yield* ready.operation;
      yield* child.halt();
      log.push("parent:continues");
    });
    expect(log).toEqual(["child:cleanup", "parent:continues", "parent:cleanup"]);
  });
  it("parent shutdown drains a suspended child", async () => {
    const log: string[] = [];
    await run(function* () {
      const ready = withResolvers<void>();
      yield* spawn(function* () {
        yield* ensure(() => {
          log.push("child:cleanup");
        });
        ready.resolve();
        yield* suspend();
      });
      yield* ready.operation;
      log.push("parent:return");
    });
    expect(log).toEqual(["parent:return", "child:cleanup"]);
  });
  it("a scoped body error runs cleanup and can be caught by the parent", async () => {
    const log: string[] = [],
      failure = new Error("body");
    await run(function* () {
      try {
        yield* scoped(function* () {
          yield* ensure(() => {
            log.push("cleanup");
          });
          throw failure;
        });
      } catch (error) {
        expect(error).toBe(failure);
        log.push("caught");
      }
      log.push("parent:continues");
    });
    expect(log).toEqual(["cleanup", "caught", "parent:continues"]);
  });
  it("a failed ensure still drains earlier registrations", async () => {
    const log: string[] = [],
      failure = new Error("cleanup");
    await expect(
      run(function* () {
        yield* ensure(() => {
          log.push("first");
        });
        yield* ensure(() => {
          log.push("second");
          throw failure;
        });
      }),
    ).rejects.toBe(failure);
    expect(log).toEqual(["second", "first"]);
  });
  it("halt waits for yielding ensure, including repeated halt requests", async () => {
    const ready = withResolvers<void>(),
      cleaning = withResolvers<void>(),
      finish = withResolvers<void>();
    const log: string[] = [];
    const task = run(function* () {
      yield* ensure(function* () {
        log.push("cleanup:start");
        cleaning.resolve();
        yield* finish.operation;
        log.push("cleanup:end");
      });
      ready.resolve();
      yield* suspend();
    });
    await run(() => ready.operation);
    const first = Promise.resolve(task.halt()).then(() => {
      return log.push("halt:1");
    });
    try {
      await run(() => cleaning.operation);
      const second = Promise.resolve(task.halt()).then(() => {
        return log.push("halt:2");
      });
      expect(log).toEqual(["cleanup:start"]);
      finish.resolve();
      await Promise.all([first, second]);
      expect(log.slice(0, 2)).toEqual(["cleanup:start", "cleanup:end"]);
      expect(log.slice(2)).toHaveLength(2);
      expect(log.slice(2)).toEqual(expect.arrayContaining(["halt:1", "halt:2"]));
    } finally {
      finish.resolve();
      await task.halt();
    }
  });
  it("AbortSignal follows its own scope, not child completion", async () => {
    let parentSignal: AbortSignal | undefined;
    await run(function* () {
      parentSignal = yield* useAbortSignal();
      const childSignal = yield* scoped(function* () {
        const signal = yield* useAbortSignal();
        expect(signal.aborted).toBe(false);
        return signal;
      });
      expect(childSignal.aborted).toBe(true);
      expect(parentSignal.aborted).toBe(false);
    });
    expect(parentSignal?.aborted).toBe(true);
  });
});

describe("Effection reference: middleware ordering", () => {
  for (const at of [undefined, "max", "min"] as const) {
    it(`same-scope ${at ?? "default"} ordering`, async () => {
      const log: string[] = [],
        service = probe(log);
      await run(function* () {
        yield* service.around(observe(log, "first"), at ? { at } : undefined);
        yield* service.around(observe(log, "second"), at ? { at } : undefined);
        expect(yield* service.operations.ping()).toBe("ok");
      });
      expect(log).toEqual(
        at === "min"
          ? ["second:in", "first:in", "core", "first:out", "second:out"]
          : ["first:in", "second:in", "core", "second:out", "first:out"],
      );
    });
  }
  for (const parentAt of ["min", "max"] as const) {
    for (const childAt of ["min", "max"] as const) {
      it(`parent ${parentAt}, child ${childAt}`, async () => {
        const log: string[] = [],
          service = probe(log);
        await run(function* () {
          yield* service.around(observe(log, "parent"), { at: parentAt });
          yield* scoped(function* () {
            yield* service.around(observe(log, "child"), { at: childAt });
            yield* service.operations.ping();
          });
        });
        const outer = parentAt === "max" ? "parent" : "child",
          inner = outer === "parent" ? "child" : "parent";
        expect(log).toEqual([`${outer}:in`, `${inner}:in`, "core", `${inner}:out`, `${outer}:out`]);
      });
    }
  }
  it("child middleware reaches grandchildren but not parent or sibling", async () => {
    const log: string[] = [],
      service = probe(log);
    await run(function* () {
      yield* scoped(function* () {
        yield* service.around(observe(log, "child"));
        yield* scoped(() => service.operations.ping());
      });
      yield* service.operations.ping();
      yield* scoped(() => service.operations.ping());
    });
    expect(log).toEqual(["child:in", "core", "child:out", "core", "core"]);
  });
  it("parent middleware updates propagate into an already-created child", async () => {
    const log: string[] = [],
      service = probe(log);
    await run(function* () {
      const parent = yield* useScope();
      yield* scoped(function* () {
        yield* service.around(observe(log, "child"));
        // Intentionally update the ancestor to measure propagation into a live child.
        parent.around(service, observe(log, "parent"));
        yield* service.operations.ping();
      });
    });
    expect(log).toEqual(["parent:in", "child:in", "core", "child:out", "parent:out"]);
  });
  for (const driverFirst of [false, true]) {
    it(`min terminal driver stays inside observers; driver first=${driverFirst}`, async () => {
      const log: string[] = [],
        service = probe(log);
      await run(function* () {
        const driver = {
          *ping(): Operation<string> {
            log.push("driver");
            return "handled";
          },
        };
        if (driverFirst) {
          yield* service.around(driver, { at: "min" });
        }
        yield* service.around(observe(log, "observer"));
        if (!driverFirst) {
          yield* service.around(driver, { at: "min" });
        }
        expect(yield* service.operations.ping()).toBe("handled");
      });
      expect(log).toEqual(["observer:in", "driver", "observer:out"]);
    });
  }
  it("a max terminal handler can hide later middleware", async () => {
    const log: string[] = [],
      service = probe(log);
    await run(function* () {
      yield* service.around({
        *ping(): Operation<string> {
          log.push("terminal");
          return "handled";
        },
      });
      yield* service.around(observe(log, "unreachable"));
      yield* service.operations.ping();
    });
    expect(log).toEqual(["terminal"]);
  });
});

describe("Effection reference: destruction interception", () => {
  for (const at of ["min", "max"] as const) {
    it(`exact-scope suppression at ${at} cannot prevent task-group cleanup or body unwinding`, async () => {
      const log: string[] = [],
        ready = withResolvers<void>();
      const [host, destroyHost] = createScope();
      let workflow: Scope | undefined,
        suppress = true;
      try {
        const task = host.run(function* () {
          workflow = yield* useScope();
          const target = workflow;
          target.around(
            api.Scope,
            {
              *destroy([scope], next) {
                if (scope === target) {
                  log.push("workflow:destroy");
                  if (suppress) {
                    return;
                  }
                }
                yield* next(scope);
              },
            },
            { at },
          );
          yield* ensure(() => {
            log.push("workflow:ensure");
          });
          try {
            ready.resolve();
            yield* suspend();
          } finally {
            log.push("workflow:finally");
          }
        });
        await run(() => ready.operation);
        await task.halt();
        // Task-group shutdown runs before the task scope destruction hook.
        expect([...log]).toEqual(["workflow:finally", "workflow:ensure", "workflow:destroy"]);
        expect(workflow).toBeDefined();
        suppress = false;
        // Complete suppressed destruction explicitly so this probe cannot leak resources.
        await run(() => api.Scope.invoke(workflow!, "destroy", [workflow!]));
        expect(log).toEqual([
          "workflow:finally",
          "workflow:ensure",
          "workflow:destroy",
          "workflow:destroy",
        ]);
      } finally {
        suppress = false;
        await destroyHost();
      }
    });
  }
  it("destroy inherits into descendants; an identity guard selects exactly one scope", async () => {
    let selected = 0,
      descendants = 0;
    await run(function* () {
      yield* scoped(function* () {
        const target = yield* useScope();
        target.around(api.Scope, {
          *destroy([scope], next) {
            if (scope === target) {
              selected++;
            } else {
              descendants++;
            }
            yield* next(scope);
          },
        });
        yield* scoped(function* () {
          yield* ensure(() => {});
        });
      });
    });
    expect(selected).toBe(1);
    expect(descendants).toBeGreaterThan(0);
  });
});

describe("Effection reference: explicit scope interception versus task halt", () => {
  for (const at of ["min", "max"] as const) {
    it(`normal scoped return at ${at} can defer resource cleanup, but the body has returned`, async () => {
      const log: string[] = [];
      await run(function* () {
        let target: Scope | undefined,
          suppress = true;
        try {
          const value = yield* scoped(function* () {
            target = yield* useScope();
            target.around(
              api.Scope,
              {
                *destroy([scope], next) {
                  if (scope === target && suppress) {
                    log.push("suppressed");
                    return;
                  }
                  yield* next(scope);
                },
              },
              { at },
            );
            yield* ensure(() => {
              log.push("cleanup");
            });
            try {
              return 42;
            } finally {
              log.push("body:finally");
            }
          });
          expect(value).toBe(42);
          expect([...log]).toEqual(["body:finally", "suppressed"]);
          log.push("parent:continues");
        } finally {
          suppress = false;
          if (target) {
            yield* api.Scope.invoke(target, "destroy", [target]);
          }
        }
        expect(log).toEqual(["body:finally", "suppressed", "parent:continues", "cleanup"]);
      });
    });
  }

  for (const at of ["min", "max"] as const) {
    it(`Scope.create observer at ${at} sees future child scopes, not its own creation`, async () => {
      await run(function* () {
        const owner = yield* useScope();
        const created: Scope[] = [];
        owner.around(
          api.Scope,
          {
            create(args, next) {
              const pair = next(...args);
              created.push(pair[0]);
              return pair;
            },
          },
          { at },
        );
        expect(created).toEqual([]);
        const child = yield* scoped(function* () {
          return yield* useScope();
        });
        expect(created).toContain(child);
        expect(created).not.toContain(owner);
      });
    });
  }

  it("native AbortController.abort does not automatically halt an Effection task", async () => {
    const ready = withResolvers<void>(),
      release = withResolvers<void>();
    const controller = new AbortController(),
      log: string[] = [];
    const task = run(function* () {
      yield* ensure(() => {
        log.push("cleanup");
      });
      ready.resolve();
      yield* release.operation;
      log.push("resumed");
    });
    try {
      await run(() => ready.operation);
      controller.abort();
      expect(controller.signal.aborted).toBe(true);
      expect(log).toEqual([]);
      release.resolve();
      await task;
      expect(log).toEqual(["resumed", "cleanup"]);
    } finally {
      release.resolve();
      await task.halt();
    }
  });
});

describe("Effection reference: signal ordering and yielding finally limitations", () => {
  for (const signalFirst of [true, false]) {
    it(`cleanup sees signal abortion according to registration order; signal first=${signalFirst}`, async () => {
      let signal: AbortSignal | undefined;
      const observed: boolean[] = [];
      await run(function* () {
        if (signalFirst) {
          signal = yield* useAbortSignal();
        }
        yield* ensure(() => {
          observed.push(signal!.aborted);
        });
        if (!signalFirst) {
          signal = yield* useAbortSignal();
        }
      });
      expect(observed).toEqual([!signalFirst]);
      expect(signal?.aborted).toBe(true);
    });
  }

  it("known limitation: yielding delegated finally can resume its caller after halt", async () => {
    // Reproduction of upstream #1190, NOT desired durable workflow behavior.
    const ready = withResolvers<void>(),
      cleaning = withResolvers<void>(),
      finish = withResolvers<void>();
    const log: string[] = [];
    function* delegated() {
      try {
        ready.resolve();
        yield* suspend();
      } finally {
        cleaning.resolve();
        yield* finish.operation;
        log.push("cleanup:done");
      }
    }
    const task = run(function* () {
      yield* delegated();
      log.push("caller:resumed");
    });
    await run(() => ready.operation);
    const halt = Promise.resolve(task.halt());
    try {
      await run(() => cleaning.operation);
      finish.resolve();
      await halt;
      expect(log).toEqual(["cleanup:done", "caller:resumed"]);
    } finally {
      finish.resolve();
      await task.halt();
    }
  });

  it("known limitation: halting while already in finally skips its remaining work", async () => {
    // Contrast with the yielding ensure test above. Reproduction of #1154.
    const cleaning = withResolvers<void>(),
      finish = withResolvers<void>();
    const log: string[] = [];
    const task = run(function* () {
      try {
        log.push("body");
      } finally {
        cleaning.resolve();
        yield* finish.operation;
        log.push("cleanup:done");
      }
    });
    try {
      await run(() => cleaning.operation);
      await task.halt();
      finish.resolve();
      expect(log).toEqual(["body"]);
    } finally {
      finish.resolve();
      await task.halt();
    }
  });

  it("suppressing a nested scoped destroy during halt still cannot retain its ensure", async () => {
    const ready = withResolvers<void>(),
      log: string[] = [];
    let target: Scope | undefined,
      suppress = true;
    const task = run(function* () {
      yield* scoped(function* () {
        target = yield* useScope();
        target.around(api.Scope, {
          *destroy([scope], next) {
            if (scope === target && suppress) {
              log.push("suppressed");
              return;
            }
            yield* next(scope);
          },
        });
        yield* ensure(() => {
          log.push("ensure");
        });
        try {
          ready.resolve();
          yield* suspend();
        } finally {
          log.push("body:finally");
        }
      });
      log.push("parent:resumed");
    });
    try {
      await run(() => ready.operation);
      await task.halt();
      expect(log[0]).toBe("body:finally");
      expect(log.indexOf("suppressed")).toBeLessThan(log.indexOf("ensure"));
      expect(log.filter((x) => x === "ensure")).toHaveLength(1);
      expect(log).not.toContain("parent:resumed");
    } finally {
      suppress = false;
      if (target) {
        await run(() => api.Scope.invoke(target!, "destroy", [target!]));
      }
      await task.halt();
    }
  });
});

describe("Effection reference: competing cleanup failures", () => {
  it("cleanup failure replaces a body failure", async () => {
    const body = new Error("body"),
      cleanup = new Error("cleanup");
    await expect(
      run(function* () {
        yield* ensure(() => {
          throw cleanup;
        });
        throw body;
      }),
    ).rejects.toBe(cleanup);
  });
  it("multiple cleanups all run; the last failing cleanup executed wins", async () => {
    const first = new Error("registered first"),
      second = new Error("registered second");
    const log: string[] = [];
    await expect(
      run(function* () {
        yield* ensure(() => {
          log.push("first");
          throw first;
        });
        yield* ensure(() => {
          log.push("second");
          throw second;
        });
      }),
    ).rejects.toBe(first);
    expect(log).toEqual(["second", "first"]);
  });
  it("halt surfaces a failing ensure and still drains other cleanup", async () => {
    const ready = withResolvers<void>(),
      failure = new Error("cleanup");
    const log: string[] = [];
    const task = run(function* () {
      yield* ensure(() => {
        log.push("earlier cleanup");
      });
      yield* ensure(() => {
        throw failure;
      });
      ready.resolve();
      yield* suspend();
    });
    await run(() => ready.operation);
    await expect(Promise.resolve(task.halt())).rejects.toBe(failure);
    expect(log).toEqual(["earlier cleanup"]);
  });
});
