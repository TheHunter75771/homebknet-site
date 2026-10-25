// Module hook for the tests: `cloudflare:sockets` only exists inside the Workers runtime, so
// under Node it resolves to a stand-in whose connect() calls globalThis.__fakeConnect.
const FAKE = new URL('./fake-sockets.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:sockets') return { url: FAKE, shortCircuit: true };
  return next(specifier, context);
}
