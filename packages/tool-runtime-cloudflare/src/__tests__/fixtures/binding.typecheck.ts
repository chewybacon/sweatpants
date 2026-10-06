import type { ToolExecutorClass } from "../../executor.ts";
import { cloudflare } from "../../index.ts";
declare const worker: WorkerStub;
cloudflare({ worker: worker.getEntrypoint<InstanceType<ToolExecutorClass>>() });

import type { ToolSessionsClass } from "../../sessions.ts";
declare const sessions: DurableObjectNamespace<InstanceType<ToolSessionsClass>>;
cloudflare({ sessions });
