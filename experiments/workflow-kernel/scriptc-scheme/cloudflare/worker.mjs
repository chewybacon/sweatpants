import { DurableObject } from "cloudflare:workers";
import { isDeepStrictEqual } from "node:util";
import { createRuntime } from "../../../../packages/v2/runtime-effection/src/index.ts";
import { createSchemeMachine } from "../../../../packages/v2/codemode-runtime-scheme/src/machine.ts";
import {
  createSqliteJournalStore,
  createDurableObjectSqliteConnection,
} from "../../../../packages/v2/storage-sqlite/src/index.ts";
import { linkReview } from "../linked.mjs";
import { createLinkedExecution } from "./execution.mts";
import { Scheme } from "./generated/reflect-worker.mjs";
import build from "./generated/workflow.json";
import html from "./index.html";

const runtime = createRuntime();
const serializer = {
  format: "linked-demo-json/1",
  encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
};
const json = (value, status = 200) => Response.json(value, { status });
export class LinkedWorkflow extends DurableObject {
  busy = false;
  async fetch(request) {
    if (this.busy) {
      return json({ error: "Command in progress" }, 409);
    }
    this.busy = true;
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        return json(await this.view());
      }
      const body = await request.json();
      if (path.endsWith("/start")) {
        if (await this.ctx.storage.get("run")) {
          return json({ error: "Already started; create a new run" }, 409);
        }
        if (typeof body.prompt !== "string" || body.prompt.length > 2000) {
          return json({ error: "Invalid prompt" }, 400);
        }
        const endpoint = this.env.OPENAI_BASE_URL.replace(/\/$/, "") + "/responses";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.env.OPENAI_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.env.CHAT_MODEL || "gpt-6-luna",
            instructions:
              'Write a tiny Scheme caller for an available compiled workflow review_draft. Return ONLY a JSON object with source (Scheme code) and input (a short draft string). Define (workflow input) which calls (review_draft input), binds the reply with let, then returns (string-append "caller:" reply). End with (workflow %input). review_draft privately elicits approval then runs cleanup; do not implement either yourself. No markdown, imports, quote, host IO, raw effects, or extra procedures. Use the user request to write the input draft.',
            input: body.prompt,
            max_output_tokens: 1800,
          }),
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok) {
          throw new Error("Live provider HTTP " + response.status);
        }
        const result = await response.json();
        if (result.status && result.status !== "completed") {
          throw new Error("Provider did not complete: " + result.status);
        }
        const text =
          result.output_text ??
          (result.output ?? [])
            .flatMap((item) => item.content ?? [])
            .filter((item) => item.type === "output_text")
            .map((item) => item.text)
            .join("");
        const authored = JSON.parse(
          text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, ""),
        );
        if (
          typeof authored.source !== "string" ||
          typeof authored.input !== "string" ||
          authored.input.length > 4000
        ) {
          throw new Error("Invalid model output");
        }
        const artifact = linkReview({
          module: build.module,
          caller: authored.source,
          identity: build.identity,
        });
        await this.ctx.storage.put("run", {
          artifact,
          caller: authored.source,
          input: authored.input,
          prompt: body.prompt,
          model: result.model ?? this.env.CHAT_MODEL,
          responseId: result.id,
          startedAt: new Date().toISOString(),
          starts: 0,
          restores: 0,
        });
        await this.advance();
      } else if (path.endsWith("/advance")) {
        await this.advance();
      } else if (path.endsWith("/answer")) {
        if (!["yes", "no", "released"].includes(body.value)) {
          return json({ error: "Invalid reply" }, 400);
        }
        await this.advance(body);
      } else {
        return json({ error: "Unknown command" }, 404);
      }
      return json(await this.view());
    } catch (error) {
      console.error(error);
      return json({ error: error.message }, 500);
    } finally {
      this.busy = false;
    }
  }
  store(run) {
    return createSqliteJournalStore({
      id: "linked-demo",
      program: run.artifact.program,
      equals: isDeepStrictEqual,
      connection: createDurableObjectSqliteConnection(this.ctx.storage),
      serialization: {
        *resolve() {
          return serializer;
        },
      },
    });
  }
  async advance(command) {
    const run = await this.ctx.storage.get("run");
    if (!run) {
      throw new Error("No run");
    }
    const current = linkReview({
      module: build.module,
      caller: run.caller,
      identity: build.identity,
    });
    if (current.program !== run.artifact.program) {
      throw new Error("Retained program requires its original compiler/runtime build");
    }
    await runtime.start(() => this.execution(run).advance(command)).result;
    // Counters are diagnostics only; controls and completion come from the journal.
    await this.ctx.storage.put("run", run);
  }
  execution(run) {
    return createLinkedExecution(runtime, {
      module: build.module,
      artifact: run.artifact,
      input: run.input,
      journal: this.store(run).open(),
      counters: run,
      loadMachine: async () => createSchemeMachine(await Scheme.load_main("kernel.wasm")),
    });
  }
  async view() {
    const run = await this.ctx.storage.get("run");
    if (!run) {
      return {
        environment: "Cloudflare local · workerd + Durable Object SQLite",
        build,
        status: "ready",
      };
    }
    const state = await runtime.start(() => this.execution(run).read()).result;
    return {
      environment: "Cloudflare local · workerd + Durable Object SQLite",
      build,
      ...run,
      ...state,
    };
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return new Response("Local only", { status: 403 });
    }
    if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
      return new Response("Origin rejected", { status: 403 });
    }
    if (url.pathname === "/") {
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const match = url.pathname.match(
      /^\/api\/runs\/([a-zA-Z0-9-]{1,80})(?:\/(start|answer|advance))?$/,
    );
    if (!match) {
      return new Response("Not found", { status: 404 });
    }
    if (Number(request.headers.get("Content-Length")) > 16384) {
      return new Response("Too large", { status: 413 });
    }
    return env.WORKFLOWS.get(env.WORKFLOWS.idFromName(match[1])).fetch(request);
  },
};
