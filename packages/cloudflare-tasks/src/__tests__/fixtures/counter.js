import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async fetch(request) {
    if (request.method === "POST") {
      await this.ctx.storage.put("count", Number(await request.text()));
    }
    return new Response(String((await this.ctx.storage.get("count")) ?? 0));
  }
}

export default {
  fetch() {
    return new Response("ready");
  },
};
