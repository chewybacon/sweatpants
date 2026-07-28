import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const frameworkRoot = resolve(process.cwd());

function source(path: string): string {
  return readFileSync(resolve(frameworkRoot, path), "utf8");
}

function sourceFiles(directory: string): string[] {
  if (!statSync(directory).isDirectory()) {
    return [directory];
  }
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") || path.endsWith(".tsx")
        ? [path]
        : [];
  });
}

describe("single crank-turner architecture", () => {
  it("keeps the chat engine free of eager producer queues and activation-local stores", () => {
    const engine = source("src/handler/durable/program-driver-chat-engine.ts");
    for (const forbidden of [
      "createSignal",
      "changed.send",
      "queue.push",
      "createInMemoryActivityStreamStore",
      "setInterval",
      "setTimeout",
    ]) {
      expect(engine, `chat engine must not contain ${forbidden}`).not.toContain(forbidden);
    }
    expect(engine).not.toMatch(/yield\*\s+spawn\s*\(/);
    expect(engine).toContain("ProgramRuntime.operations.run");
  });

  it("keeps ProgramDriver implementations passive", () => {
    const roots = [
      resolve(frameworkRoot, "../session-contract/src/program-driver.ts"),
      resolve(frameworkRoot, "../tool-runtime-local/src"),
      resolve(frameworkRoot, "../tool-runtime-agentcore/src"),
    ];
    for (const file of roots.flatMap(sourceFiles).filter((file) => !file.includes("__tests__"))) {
      const contents = readFileSync(file, "utf8");
      if (!contents.includes("ProgramDriver") && !file.includes("durable-driver")) {
        continue;
      }
      expect(contents, `${file} must not create a signal-driven producer`).not.toContain(
        "createSignal",
      );
      expect(contents, `${file} must not timer-poll driver progress`).not.toContain("setInterval(");
    }
  });

  it("keeps authored sampling on the canonical contract without preference-field tunneling", () => {
    const program = source("../chat-core/src/authoring/program.ts");
    const contracts = source("../chat-core/src/authoring/contracts.ts");
    expect(program).not.toContain("sweatpants.authored-model-bridge");
    expect(contracts).not.toContain("CHAT_MODEL_SAMPLE_INPUT_DESCRIPTOR");
    expect(contracts).not.toContain("CHAT_MODEL_SAMPLE_OUTPUT_DESCRIPTOR");
  });

  it("has no unfenced TokenBuffer mutation surface", () => {
    const contracts = source("../durable-streams/src/types.ts");
    const tokenBuffer = contracts.slice(
      contracts.indexOf("export interface TokenBuffer<T>"),
      contracts.indexOf("export interface TokenBufferStore<T>"),
    );
    expect(tokenBuffer).not.toMatch(/^\s+(append|complete|fail)\(/m);

    const registry = readFileSync(
      resolve(frameworkRoot, "../durable-chat-runtime/src/response-streams/session-registry.ts"),
      "utf8",
    );
    expect(registry).not.toContain("buffer.append(");
    expect(registry).not.toContain("buffer.complete(");
    expect(registry).not.toContain("buffer.fail(");
  });

  it("has exactly one response-buffer source writer in session orchestration", () => {
    const registry = readFileSync(
      resolve(frameworkRoot, "../durable-chat-runtime/src/response-streams/session-registry.ts"),
      "utf8",
    );
    expect(registry.match(/writeFromStreamToBuffer\(/g)).toHaveLength(1);
    expect(registry).toContain("startOwnedTask");

    const handler = source("src/handler/durable/handler.ts");
    expect(handler).toContain("source: (_responseTokenBuffer, responseTokenWriter)");
    // The sole append site lives in the extracted serialized event stream; the
    // handler wires it as the one session source.
    const eventStream = readFileSync(
      resolve(frameworkRoot, "../durable-chat-runtime/src/response-streams/event-stream.ts"),
      "utf8",
    );
    expect(eventStream.match(/responseTokenBuffer\.append/g)).toHaveLength(1);
    expect(handler).not.toContain("responseTokenBuffer.append");
    expect(registry).toContain("buffer.claimWriter");
  });
});
