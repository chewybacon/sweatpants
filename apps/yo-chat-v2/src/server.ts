import { createNodeServer, closeNodeServer } from "./node-server.ts";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createRuntime } from "@sweatpan.ts/runtime-effection";
import { createApplication } from "./application.ts";
import { createModelSampling } from "./model.ts";

const runtime = createRuntime();
const sampling = await createModelSampling(runtime);
await mkdir("data", { recursive: true });
const db = new DatabaseSync(process.env["CHAT_DATABASE"] ?? "data/chat.sqlite");
const app = createApplication(runtime, db, { sampling });
const port = Number(process.env["PORT"] ?? 8001);
const origin = `http://localhost:${port}`;
const server = createNodeServer(app);
server.listen(port, "127.0.0.1", () => {
  console.log(`yo-chat v2: ${origin}`);
});
let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  await closeNodeServer(server, app);
  db.close();
}
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
