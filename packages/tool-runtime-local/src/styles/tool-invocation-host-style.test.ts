import { scoped, type Operation } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHandleHost,
  createHostScope,
  createInvocationHost,
  HandleHostPort,
  InvocationHostPort,
  InvocationNotFound,
  type Disposition,
  type ToolBody,
} from "./tool-invocation-host-style.ts";

/** A two-step tool: elicit, then sample, then return. The PoC's book-flight shape. */
const bookFlight: ToolBody = function* (input, context) {
  const flight = yield* context.ask("elicit", `pick a flight from ${input}`);
  const tip = yield* context.ask("sample", `write a tip for ${flight}`);
  return `${flight}|${tip}`;
};

let teardown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await teardown?.();
  teardown = undefined;
});

/** A host scope that outlives every request scope below. */
function hostScope() {
  const [scope, destroy] = createHostScope();
  teardown = destroy;
  return scope;
}

describe("tool invocation host: the property the PoC needed", () => {
  it("keeps a parked invocation alive after the starting request scope exits", async () => {
    const scope = hostScope();

    const parked = await scope.run(function* () {
      const host = yield* createInvocationHost();
      yield* InvocationHostPort.installDriver(host);

      // Request A: start and turn until the body parks, then exit.
      const first = yield* scoped(function* (): Operation<Disposition> {
        const facade = yield* InvocationHostPort.use();
        yield* facade.start("booking", bookFlight, "SFO");
        return yield* facade.turn("booking");
      });
      expect(first).toMatchObject({ type: "parked", kind: "elicit" });

      // Request A's scope is gone. The invocation must still be parked.
      const facade = yield* InvocationHostPort.use();
      return yield* facade.status("booking");
    });

    expect(parked, "invocation must outlive the scope that started it").toBe("parked");
  });

  it("resumes a parked invocation from a different request scope", async () => {
    const scope = hostScope();

    const output = await scope.run(function* () {
      const driver = yield* createInvocationHost();
      yield* InvocationHostPort.installDriver(driver);

      // Request A: start, park on the elicit, exit.
      const elicit = yield* scoped(function* (): Operation<Disposition> {
        const facade = yield* InvocationHostPort.use();
        yield* facade.start("booking", bookFlight, "SFO");
        return yield* facade.turn("booking");
      });
      if (elicit.type !== "parked") throw new Error("expected an elicit park");

      // Request B: answer the elicit, turn to the next park, exit.
      const sample = yield* scoped(function* (): Operation<Disposition> {
        const facade = yield* InvocationHostPort.use();
        yield* facade.respond("booking", elicit.requestId, "UA-100");
        return yield* facade.turn("booking");
      });
      if (sample.type !== "parked") throw new Error("expected a sample park");
      expect(sample.kind).toBe("sample");

      // Request C: answer the sample and collect the terminal disposition.
      return yield* scoped(function* (): Operation<Disposition> {
        const facade = yield* InvocationHostPort.use();
        yield* facade.respond("booking", sample.requestId, "sit in 14A");
        return yield* facade.turn("booking");
      });
    });

    expect(output).toEqual({ type: "completed", output: "UA-100|sit in 14A" });
  });

  it("unwinds a parked invocation on cancel", async () => {
    const scope = hostScope();

    const terminal = await scope.run(function* () {
      const driver = yield* createInvocationHost();
      yield* InvocationHostPort.installDriver(driver);
      const facade = yield* InvocationHostPort.use();

      yield* facade.start("booking", bookFlight, "SFO");
      expect(yield* facade.turn("booking")).toMatchObject({ type: "parked" });

      yield* facade.cancel("booking");
      return yield* facade.turn("booking");
    });

    expect(terminal).toEqual({ type: "cancelled" });
  });

  it("does not evict an invocation that is still parked when its last reader leaves", async () => {
    const scope = hostScope();

    const status = await scope.run(function* () {
      const driver = yield* createInvocationHost();
      yield* InvocationHostPort.installDriver(driver);
      const facade = yield* InvocationHostPort.use();

      yield* facade.start("booking", bookFlight, "SFO");
      yield* facade.turn("booking");
      // The only reader disconnects while the body is parked.
      yield* facade.release("booking");

      return yield* facade.status("booking");
    });

    expect(status).toBe("parked");
  });

  it("fails closed with no host installed, and reports unknown invocations", async () => {
    const scope = hostScope();

    await expect(
      scope.run(function* () {
        const facade = yield* InvocationHostPort.use();
        yield* facade.status("missing");
      }),
    ).rejects.toMatchObject({ code: "invocation_host_unavailable" });

    await expect(
      scope.run(function* () {
        const driver = yield* createInvocationHost();
        yield* InvocationHostPort.installDriver(driver);
        const facade = yield* InvocationHostPort.use();
        yield* facade.status("missing");
      }),
    ).rejects.toBeInstanceOf(InvocationNotFound);
  });
});

/**
 * The actual design question: which interactions can a scope observe?
 *
 * Both styles run the same three-request flow. The only difference is whether
 * turn/respond/cancel are port members or handle methods.
 */
describe("what scope middleware can observe", () => {
  it("sees only acquisition when the host hands out a handle (style H)", async () => {
    const scope = hostScope();
    const observed: string[] = [];

    await scope.run(function* () {
      const driver = yield* createHandleHost();
      yield* HandleHostPort.installDriver(driver);
      yield* HandleHostPort.api.around({
        *start([id, body, input], next) {
          observed.push(`start:${id}`);
          return yield* next(id, body, input);
        },
        *attach([id], next) {
          observed.push(`attach:${id}`);
          return yield* next(id);
        },
        *release([id], next) {
          observed.push(`release:${id}`);
          return yield* next(id);
        },
      });

      const elicit = yield* scoped(function* (): Operation<Disposition> {
        const host = yield* HandleHostPort.use();
        const handle = yield* host.start("booking", bookFlight, "SFO");
        return yield* handle.turn();
      });
      if (elicit.type !== "parked") throw new Error("expected a park");

      const sample = yield* scoped(function* (): Operation<Disposition> {
        const host = yield* HandleHostPort.use();
        const handle = yield* host.attach("booking");
        yield* handle.respond(elicit.requestId, "UA-100");
        return yield* handle.turn();
      });
      if (sample.type !== "parked") throw new Error("expected a park");

      yield* scoped(function* () {
        const host = yield* HandleHostPort.use();
        const handle = yield* host.attach("booking");
        yield* handle.respond(sample.requestId, "sit in 14A");
        expect(yield* handle.turn()).toEqual({
          type: "completed",
          output: "UA-100|sit in 14A",
        });
        yield* host.release("booking");
      });
    });

    // Every turn and every response is invisible to the scope.
    expect(observed).toEqual([
      "start:booking",
      "attach:booking",
      "attach:booking",
      "release:booking",
    ]);
  });

  it("sees the whole interaction when every operation is a port member (style F)", async () => {
    const scope = hostScope();
    const observed: string[] = [];

    await scope.run(function* () {
      const driver = yield* createInvocationHost();
      yield* InvocationHostPort.installDriver(driver);
      yield* InvocationHostPort.api.around({
        *start([id, body, input], next) {
          observed.push(`start:${id}`);
          return yield* next(id, body, input);
        },
        *turn([id], next) {
          const disposition = yield* next(id);
          observed.push(`turn:${id}:${disposition.type}`);
          return disposition;
        },
        *respond([id, requestId, value], next) {
          observed.push(`respond:${id}:${requestId}`);
          return yield* next(id, requestId, value);
        },
        *release([id], next) {
          observed.push(`release:${id}`);
          return yield* next(id);
        },
      });

      const elicit = yield* scoped(function* (): Operation<Disposition> {
        const facade = yield* InvocationHostPort.use();
        yield* facade.start("booking", bookFlight, "SFO");
        return yield* facade.turn("booking");
      });
      if (elicit.type !== "parked") throw new Error("expected a park");

      const sample = yield* scoped(function* (): Operation<Disposition> {
        const facade = yield* InvocationHostPort.use();
        yield* facade.respond("booking", elicit.requestId, "UA-100");
        return yield* facade.turn("booking");
      });
      if (sample.type !== "parked") throw new Error("expected a park");

      yield* scoped(function* () {
        const facade = yield* InvocationHostPort.use();
        yield* facade.respond("booking", sample.requestId, "sit in 14A");
        yield* facade.turn("booking");
        yield* facade.release("booking");
      });
    });

    expect(observed).toEqual([
      "start:booking",
      "turn:booking:parked",
      "respond:booking:booking:req:1",
      "turn:booking:parked",
      "respond:booking:booking:req:2",
      "turn:booking:completed",
      "release:booking",
    ]);
  });

  it("lets a child scope shadow the host without disturbing the parent's invocations", async () => {
    const scope = hostScope();

    const [outer, inner] = await scope.run(function* (): Operation<[string, string]> {
      const driver = yield* createInvocationHost();
      yield* InvocationHostPort.installDriver(driver);
      const outerFacade = yield* InvocationHostPort.use();
      yield* outerFacade.start("shared-id", bookFlight, "outer");
      yield* outerFacade.turn("shared-id");

      const innerOutput = yield* scoped(function* () {
        // A nested composition installs its own host; the same invocation id
        // must resolve to the child's invocation, not the parent's.
        const driver = yield* createInvocationHost();
        yield* InvocationHostPort.installDriver(driver);
        const facade = yield* InvocationHostPort.use();
        yield* facade.start("shared-id", bookFlight, "inner");
        const parked = yield* facade.turn("shared-id");
        if (parked.type !== "parked") throw new Error("expected a park");
        yield* facade.respond("shared-id", parked.requestId, "inner-flight");
        const next = yield* facade.turn("shared-id");
        if (next.type !== "parked") throw new Error("expected a park");
        return next.requestId;
      });

      // The parent's invocation is untouched and still parked on its elicit.
      const outerStatus = yield* outerFacade.status("shared-id");
      return [outerStatus, innerOutput];
    });

    expect(outer).toBe("parked");
    expect(inner).toBe("shared-id:req:2");
  });
});
