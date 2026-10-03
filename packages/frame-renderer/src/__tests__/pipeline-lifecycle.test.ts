import { call, run } from "effection";
import { expect, it } from "vitest";
import { createPipeline, markdown, PipelineLifecycleError } from "../index.ts";

// A controllable asynchronous renderer boundary, without timing assumptions.
function gate() {
  let release!: () => void;
  let enter!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    started,
    release,
    *wait() {
      enter();
      yield* call(() => released);
    },
  };
}

it("publishes only a finished frame and batches arrivals during rendering for the next pull", async () => {
  const blocked = gate();
  let renders = 0;
  const pipeline = createPipeline({
    processors: [
      markdown,
      {
        name: "slow",
        dependencies: ["markdown"],
        *process(frame) {
          if (++renders === 1) {
            yield* blocked.wait();
          }
          return frame;
        },
      },
    ],
  });
  const initial = pipeline.frame;
  pipeline.push("First **frame**.\n");
  const pulling = run(() => pipeline.pull());
  await blocked.started;
  expect(pipeline.frame).toBe(initial);
  expect(pipeline.frame.blocks).toEqual([]);
  expect(pipeline.hasPending).toBe(true);
  pipeline.push("Next frame.\n");
  blocked.release();
  const first = await pulling;
  expect(pipeline.frame).toBe(first);
  expect(first.blocks[0]?.rendered).toContain("<strong>frame</strong>");
  expect(first.blocks[0]?.raw).toBe("First **frame**.\n");
  expect(pipeline.hasPending).toBe(true);
  const second = await run(() => pipeline.pull());
  expect(second.blocks[0]?.raw).toBe("First **frame**.\nNext frame.\n");
  expect(first.blocks[0]?.raw).toBe("First **frame**.\n");
  expect(renders).toBe(2);
  expect(pipeline.hasPending).toBe(false);
  expect(await run(() => pipeline.pull())).toBe(second);
  expect(renders).toBe(2);
});

it("rejects overlapping pull and flush operations without disturbing the active render", async () => {
  const blocked = gate();
  const pipeline = createPipeline({
    processors: [
      {
        name: "slow",
        *process(frame) {
          yield* blocked.wait();
          return frame;
        },
      },
    ],
  });
  pipeline.push("One\n");
  const pulling = run(() => pipeline.pull());
  await blocked.started;
  await expect(run(() => pipeline.pull())).rejects.toMatchObject({
    name: "PipelineLifecycleError",
    code: "busy",
  });
  await expect(run(() => pipeline.flush())).rejects.toBeInstanceOf(PipelineLifecycleError);
  expect(pipeline.isDone).toBe(false);
  blocked.release();
  expect((await pulling).blocks[0]?.raw).toBe("One\n");
});

it("rolls back parser state and preserves arrival order when a pull is cancelled", async () => {
  const blocked = gate();
  let renders = 0;
  const pipeline = createPipeline({
    processors: [
      markdown,
      {
        name: "slow",
        dependencies: ["markdown"],
        *process(frame) {
          if (++renders === 2) {
            yield* blocked.wait();
          }
          return frame;
        },
      },
    ],
  });
  pipeline.push("```text\nfirst\npar");
  const open = await run(() => pipeline.pull());
  pipeline.push("tial\n```\nAfter\n");
  const pulling = run(() => pipeline.pull());
  await blocked.started;
  pipeline.push("Later\n");
  await pulling.halt();
  expect(pipeline.frame).toBe(open);
  expect(pipeline.hasPending).toBe(true);
  const recovered = await run(() => pipeline.flush());
  expect(recovered.blocks.map((block) => [block.type, block.raw])).toEqual([
    ["code", "first\npartial\n"],
    ["text", "After\nLater\n"],
  ]);
  expect(recovered.blocks[0]?.status).toBe("complete");
  expect(pipeline.isDone).toBe(true);
});

it("publishes a flush once, rejects arrivals while closing, and returns the final frame thereafter", async () => {
  const blocked = gate();
  let renders = 0;
  const pipeline = createPipeline({
    processors: [
      {
        name: "slow",
        *process(frame) {
          renders++;
          yield* blocked.wait();
          return frame;
        },
      },
    ],
  });
  const initial = pipeline.frame;
  pipeline.push("Whole line\nPartial line");
  const flushing = run(() => pipeline.flush());
  await blocked.started;
  expect(pipeline.frame).toBe(initial);
  expect(pipeline.isDone).toBe(false);
  expect(() => pipeline.push("too late")).toThrow("closing or finished");
  blocked.release();
  const final = await flushing;
  expect(final.blocks[0]?.raw).toBe("Whole line\nPartial line");
  expect(renders).toBe(1);
  expect(pipeline.frame).toBe(final);
  expect(pipeline.isDone).toBe(true);
  expect(pipeline.hasPending).toBe(false);
  expect(await run(() => pipeline.flush())).toBe(final);
  expect(await run(() => pipeline.pull())).toBe(final);
  expect(() => pipeline.push("too late")).toThrow("closing or finished");
});

it.each(["error", "cancel"] as const)(
  "reopens a %s-interrupted flush and retries its input",
  async (failure) => {
    const blocked = gate();
    let renders = 0;
    const pipeline = createPipeline({
      processors: [
        {
          name: "slow",
          *process(frame) {
            if (++renders === 1) {
              yield* blocked.wait();
              throw new Error("Render failed");
            }
            return frame;
          },
        },
      ],
    });
    const initial = pipeline.frame;
    pipeline.push("Original");
    const flushing = run(() => pipeline.flush());
    await blocked.started;
    if (failure === "error") {
      blocked.release();
      // oxlint-disable-next-line jest/no-conditional-expect -- only the error case rejects; cancellation is verified through halt and the shared state assertions.
      await expect(flushing).rejects.toThrow("Render failed");
    } else {
      await flushing.halt();
    }
    expect(pipeline.frame).toBe(initial);
    expect(pipeline.isDone).toBe(false);
    expect(pipeline.hasPending).toBe(true);
    pipeline.push(" plus new");
    const final = await run(() => pipeline.flush());
    expect(final.blocks[0]?.raw).toBe("Original plus new");
    expect(pipeline.isDone).toBe(true);
  },
);

it.each(["pull", "flush"] as const)(
  "reset clears parser state and prevents an old %s from publishing",
  async (operation) => {
    const blocked = gate();
    let renders = 0;
    const pipeline = createPipeline({
      processors: [
        {
          name: "slow",
          *process(frame) {
            if (++renders === 2) {
              yield* blocked.wait();
            }
            return frame;
          },
        },
      ],
    });
    pipeline.push("```text\nold\npartial");
    await run(() => pipeline.pull());
    pipeline.push(" tail\n");
    const oldPull = run(() => pipeline[operation]());
    await blocked.started;
    pipeline.reset();
    expect(pipeline.frame.blocks).toEqual([]);
    expect(pipeline.hasPending).toBe(false);
    pipeline.push("New **document**");
    const current = await run(() => pipeline.flush());
    blocked.release();
    await expect(oldPull).rejects.toMatchObject({ code: "reset" });
    expect(pipeline.frame).toBe(current);
    expect(current.blocks.map((block) => [block.type, block.raw])).toEqual([
      ["text", "New **document**"],
    ]);
    expect(pipeline.hasPending).toBe(false);
    expect(pipeline.isDone).toBe(true);
  },
);
