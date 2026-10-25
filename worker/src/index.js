/*
 * homebknet-status: the live status Worker behind https://homebknet.us/status.json.
 * Routed on that one path only (wrangler.toml); everything else on the apex is Cloudflare Pages.
 *
 * This file only wires the runtime in. The logic is in handler.js, and the probes are in
 * watch.js and minecraft.js, which take their I/O as arguments so the tests can run offline.
 */
import { connect } from 'cloudflare:sockets';
import { handleRequest, createIsolateState } from './handler.js';

// Lives as long as this isolate: the last probe round and whether one is running. Plain data only.
const isolate = createIsolateState();

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx, {
      // Wrapped so it stays safe even if it's ever called as deps.fetch(): the runtime's fetch
      // throws "Illegal invocation" when called as a method of another object. (watch.js calls
      // it as a plain function today, so this is belt and braces, not a tested guard.)
      fetch: (input, init) => fetch(input, init),
      connect,
      cache: typeof caches !== 'undefined' && caches ? caches.default : null,
      now: () => Date.now(),
      isolate,
    });
  },
};
