import type { ToolExecutorClass } from "@sweatpants/tool-runtime-cloudflare/executor";
import { cloudflare } from "@sweatpants/tool-runtime-cloudflare";
declare const worker: WorkerStub;
cloudflare({ worker: worker.getEntrypoint<InstanceType<ToolExecutorClass>>() });

import type { ToolSessionsClass } from "@sweatpants/tool-runtime-cloudflare/sessions";
declare const sessions: DurableObjectNamespace<InstanceType<ToolSessionsClass>>;
cloudflare({ sessions });

import type { ToolExecutorObjectClass } from "@sweatpants/tool-runtime-cloudflare/executor";
declare const executors: DurableObjectNamespace<InstanceType<ToolExecutorObjectClass>>;
cloudflare({ executors, sessions });
