export { ToolSessions } from "../../src/server/cloudflare-tool-sessions";
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import type { ToolExecutorRpc } from "@sweatpants/tool-runtime-cloudflare";
import type { ToolExecutorClass } from "@sweatpants/tool-runtime-cloudflare/executor";
export default class Host extends WorkerEntrypoint<{ LOADER: WorkerLoader; CODE: string }> {
  async createExecutor() {
    const target = await this.env.LOADER.load({
      compatibilityDate: "2026-10-05",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: { "executor.js": this.env.CODE },
      globalOutbound: null,
    })
      .getEntrypoint<InstanceType<ToolExecutorClass>>()
      .createExecutor();
    return new NodeProxy(target);
  }
}

// Miniflare's Node proxy does not forward Symbol.dispose. Bridge it explicitly
// inside workerd, where the real RPC stub and its disposal live.
class NodeProxy extends RpcTarget {
  constructor(private target: ToolExecutorRpc) {
    super();
  }
  attach(request: string) {
    return this.target.attach(request);
  }
  step(id: string, command: string) {
    return this.target.step(id, command);
  }
  shutdown(id: string, reason: string) {
    return this.target.shutdown(id, reason);
  }
  dispose() {
    this.target[Symbol.dispose]();
  }
}
