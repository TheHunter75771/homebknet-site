// The entry module as the runtime loads it: real `fetch`, `caches` and `cloudflare:sockets`
// globals/imports (stood in for offline), wired through src/index.js.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { CACHE_KEY } from '../src/handler.js';
import { WATCH_HEALTH_URL } from '../src/watch.js';
import { statusFrame, REAL_STATUS, fakeSocket, fakeConnect, fakeCache, fakeCtx, sleep } from './helpers/fakes.mjs';

register('./helpers/sockets-loader.mjs', import.meta.url);

// index.js keeps per-isolate state at module scope, so each test loads its own copy (a fresh
// "isolate") by importing it under a distinct URL.
let copies = 0;
const freshWorker = async () => (await import(`../src/index.js?isolate=${++copies}`)).default;

const ENV = { NOTICE_TEXT: '', NOTICE_LEVEL: 'info', CACHE_SECONDS: '30' };
const saved = {};
let fetchCalls;

beforeEach(() => {
  saved.fetch = globalThis.fetch;
  saved.caches = globalThis.caches;
  fetchCalls = [];
  // Like the runtime's fetch: refuses to run as a method of some other object.
  globalThis.fetch = async function (input, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    fetchCalls.push({ url: String(input), init });
    await sleep(30);
    return new Response('Healthy');
  };
  globalThis.__fakeConnect = fakeConnect(() => fakeSocket({ steps: [statusFrame(REAL_STATUS)] }).socket);
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  if (saved.caches === undefined) delete globalThis.caches;
  else globalThis.caches = saved.caches;
  delete globalThis.__fakeConnect;
});

test('the deployed entry point answers /status.json end to end', async () => {
  const worker = await freshWorker();
  const cache = fakeCache();
  globalThis.caches = { default: cache };
  const ctx = fakeCtx();
  const res = await worker.fetch(new Request('https://homebknet.us/status.json'), ENV, ctx);
  await ctx.flush();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = await res.json();
  assert.equal(body.watch.state, 'online', 'fetch is called the way the runtime allows');
  assert.equal(body.games[0].state, 'online');
  assert.equal(body.games[0].players, 2);
  assert.deepEqual(fetchCalls.map((c) => [c.url, c.init.redirect]), [[WATCH_HEALTH_URL, 'manual']]);
  assert.deepEqual(globalThis.__fakeConnect.calls.map((c) => c.address), [{ hostname: 'game.homebknet.us', port: 25565 }]);
  assert.deepEqual(cache.log.put.map((p) => p.key), [CACHE_KEY]);

  const again = await worker.fetch(new Request('https://homebknet.us/status.json'), ENV, fakeCtx());
  assert.equal(again.status, 200);
  assert.equal(fetchCalls.length, 1, 'second request reuses the first round');
});

test('the entry point keeps one isolate state: concurrent requests share one round', async () => {
  const worker = await freshWorker();
  globalThis.caches = { default: fakeCache() };
  const responses = await Promise.all(Array.from({ length: 25 }, () => worker.fetch(new Request('https://homebknet.us/status.json'), ENV, fakeCtx())));
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(fetchCalls.length, 1);
  assert.equal(globalThis.__fakeConnect.calls.length, 1);
});

test('it still answers where the Cache API is missing', async () => {
  const worker = await freshWorker();
  delete globalThis.caches;
  const res = await worker.fetch(new Request('https://homebknet.us/status.json'), ENV, fakeCtx());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).watch.state, 'online');
  assert.equal(fetchCalls.length, 1, 'probed: this copy had no earlier round');
});
