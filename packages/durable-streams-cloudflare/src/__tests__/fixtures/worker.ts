import { ResponseStream } from "../../worker.ts";
import type { ResponseStreamNamespace, ResponseStreamRpc } from "../../protocol.ts";
export { ResponseStream };
export default {
  async fetch(request: Request, env: { STREAMS: ResponseStreamNamespace }) {
    const { id, method, args } = (await request.json()) as {
      id: string;
      method: keyof ResponseStreamRpc;
      args: unknown[];
    };
    const stub = env.STREAMS.getByName(id);
    const invoke = stub[method] as (...values: unknown[]) => Promise<unknown>;
    return Response.json(await invoke(...args));
  },
};
