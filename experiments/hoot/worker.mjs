import { Scheme } from './reflect-worker.mjs';
import { scenarios } from './scenarios.mjs';
export default {
  async fetch(request) {
    if (new URL(request.url).pathname === '/health') return new Response('hoot-spike');
    const started = Date.now();
    try {
      const result = await scenarios(() => Scheme.load_main('kernel.wasm'));
      return Response.json({ runtime: 'workerd', elapsedMs: Date.now() - started, ...result });
    } catch (error) {
      return Response.json({ error: String(error), stack: error.stack }, { status: 500 });
    }
  }
};
