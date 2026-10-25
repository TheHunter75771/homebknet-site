// Stand-in for `cloudflare:sockets` under Node (see sockets-loader.mjs).
export function connect(address, options) {
  if (typeof globalThis.__fakeConnect !== 'function') throw new Error('no fake connect installed');
  return globalThis.__fakeConnect(address, options);
}
