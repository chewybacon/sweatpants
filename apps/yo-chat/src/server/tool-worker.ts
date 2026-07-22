/**
 * yo-chat ToolSession worker entry.
 *
 * Hand-authored, replacing the previously generated tool-worker.gen.ts: the
 * worker imports the same authored tool definitions the host composes with,
 * so single-authoring is preserved without a codegen step.
 */
import { runToolWorkerEntry } from "@sweatpants/tool-runtime-local/worker";
import { workerTools } from "./worker-tools.ts";

await runToolWorkerEntry([...workerTools]);
