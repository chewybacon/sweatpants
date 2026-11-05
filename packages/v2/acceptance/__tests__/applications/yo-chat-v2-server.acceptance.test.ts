import { request as httpRequest } from "node:http";
import { expect, it, onTestFinished } from "vitest";
import { createApplication } from "../../../../../apps/yo-chat-v2/src/application.ts";
import {
  createNodeServer,
  closeNodeServer,
} from "../../../../../apps/yo-chat-v2/src/node-server.ts";
import { createLatch, createSqliteDatabaseRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: Node listener shutdown closes active uploads and joins model cleanup before SQLite closes`, async () => {
    const database = createSqliteDatabaseRig();
    const started = createLatch<void>();
    const release = createLatch<void>();
    let cleaned = false;
    const app = createApplication(runtime, database.database, {
      sampling: {
        *sample() {
          yield* runtime.composition.ensure(function* () {
            cleaned = true;
          });
          started.resolve();
          yield* runtime.fromPromise(() => release.promise);
          throw new Error("Interrupted model");
        },
      },
    });
    const server = createNodeServer(app);
    onTestFinished(async () => {
      release.resolve();
      await closeNodeServer(server, app);
      database.close();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing server address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const get = await fetch(origin + "/api/conversation");
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ status: "empty" });
    const html = await fetch(origin);
    expect(html.status).toBe(200);
    await html.text();
    const asset = await fetch(origin + "/client.js");
    expect(asset.status).toBe(200);
    await asset.text();
    const foreign = await fetch(origin + "/api/conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://foreign.example" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    await foreign.text();
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(origin, { headers: { Host: "foreign.example" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      request.end();
    });
    expect(badHost).toBe(403);
    const oversized = await fetch(origin + "/api/conversation", {
      method: "POST",
      body: "x".repeat(65537),
    });
    expect(oversized.status).toBe(413);
    await oversized.text();
    // A full request is advancing, while another socket is still uploading its body.
    const pending = fetch(origin + "/api/conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "stopping", prompt: "Hello", after: null }),
    }).then(
      () => "response",
      () => "disconnected",
    );
    await started.promise;
    const uploadStarted = createLatch<void>();
    server.once("request", () => uploadStarted.resolve());
    const upload = httpRequest(origin + "/api/conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": 1000 },
    });
    upload.on("error", () => undefined);
    const uploadClosed = new Promise<void>((resolve) => upload.once("close", resolve));
    onTestFinished(() => {
      upload.destroy();
    });
    upload.write("{");
    await uploadStarted.promise;
    await closeNodeServer(server, app);
    await uploadClosed;
    await pending;
    expect(cleaned).toBe(true);
    expect(server.listening).toBe(false);
    expect((await app.fetch(new Request(origin + "/api/conversation"))).status).toBe(503);
    // All application reads/tasks are joined, so closing this connection is now safe.
    database.reopen();
  });
});
