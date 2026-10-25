// The /status.json handler: document, failures, caching, methods, notice, headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleRequest, settleProbe, parseNotice, cacheSeconds, createIsolateState,
  CACHE_KEY, RESPONSE_HEADERS, MAX_NOTICE_CHARS,
} from '../src/handler.js';
import { WATCH_HEALTH_URL } from '../src/watch.js';
import { statusFrame, REAL_STATUS, fakeSocket, fakeConnect, fakeFetch, fakeCache, fakeCtx, deafFetch, sleep } from './helpers/fakes.mjs';

const T0 = Date.parse('2026-10-25T18:30:00Z');
const ENV = { NOTICE_TEXT: '', NOTICE_LEVEL: 'info', CACHE_SECONDS: '30' };
const NULLS = { players: null, maxPlayers: null, version: null };
const MC = { id: 'mc-hardcore', name: 'Minecraft Hardcore', address: 'game.homebknet.us:25565' };
const PZ = { id: 'zomboid', name: 'Project Zomboid', address: 'game.homebknet.us:16261' };
const ch = (cp) => String.fromCodePoint(cp);

function setup({ watch, mc, connect, cache = null, timeoutMs = 150, isolate = null, responseBudgetMs } = {}) {
  const fetch = fakeFetch(watch || (() => new Response('Healthy')));
  const sockets = [];
  const conn = connect || fakeConnect(() => {
    const s = fakeSocket(mc || { steps: [statusFrame(REAL_STATUS)] });
    sockets.push(s);
    return s.socket;
  });
  const s = { clock: T0, fetch, connect: conn, sockets, ctx: fakeCtx(), cache };
  s.deps = { fetch, connect: conn, cache, now: () => s.clock, timeoutMs, isolate };
  if (responseBudgetMs !== undefined) s.deps.responseBudgetMs = responseBudgetMs;
  return s;
}

async function call(s, { path = '/status.json', method = 'GET', env = ENV, headers } = {}) {
  const res = await handleRequest(new Request(`https://homebknet.us${path}`, { method, headers }), env, s.ctx, s.deps);
  await s.ctx.flush();
  const text = res.body ? await res.text() : '';
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { res, text, body };
}

const probes = (s) => ({ fetch: s.fetch.calls.length, connect: s.connect.calls.length });

// ---- the document -------------------------------------------------------------

test('normal night: the exact document, in the fixture key order', async () => {
  const s = setup();
  const { res, body, text } = await call(s);
  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    updated: '2026-10-25T18:30:00Z',
    watch: { state: 'online' },
    games: [
      { ...MC, state: 'online', players: 2, maxPlayers: 20, version: '26.1.2' },
      { ...PZ, state: 'unknown', ...NULLS },
    ],
    notice: null,
  });
  assert.deepEqual(Object.keys(body), ['updated', 'watch', 'games', 'notice']);
  for (const g of body.games) assert.deepEqual(Object.keys(g), ['id', 'name', 'address', 'state', 'players', 'maxPlayers', 'version']);
  assert.ok(!/stack|Error|at \w+ \(/.test(text));
});

test('updated is the probe time, to the second', async () => {
  const s = setup();
  s.clock = T0 + 1999;
  assert.equal((await call(s)).body.updated, '2026-10-25T18:30:01Z');
});

test('bad night: everything down still answers 200 with a full document', async () => {
  const s = setup({ watch: () => new Response('error code: 1033', { status: 530 }), mc: { opened: 'reject' } });
  const { res, body } = await call(s);
  assert.equal(res.status, 200);
  assert.equal(body.watch.state, 'offline');
  assert.deepEqual(body.games.map((g) => g.state), ['offline', 'unknown']);
  assert.deepEqual(body.games[0], { ...MC, state: 'offline', ...NULLS });
});

// ---- failures stay local -----------------------------------------------------------

test('watch probe throwing does not touch the game results', async () => {
  const s = setup({ watch: () => { throw new Error('SECRET-fetch-detail'); } });
  const { res, body, text } = await call(s);
  assert.equal(res.status, 200);
  assert.equal(body.watch.state, 'unknown');
  assert.equal(body.games[0].state, 'online');
  assert.ok(!text.includes('SECRET'));
});

test('game probe throwing does not touch watch', async () => {
  const s = setup({ connect: () => { throw new Error('SECRET-connect-detail'); } });
  const { res, body, text } = await call(s);
  assert.equal(res.status, 200);
  assert.equal(body.watch.state, 'online');
  assert.deepEqual(body.games[0], { ...MC, state: 'unknown', ...NULLS });
  assert.ok(!text.includes('SECRET'));
});

test('both probes throwing: still 200, all unknown, nothing internal in the output', async () => {
  const s = setup({
    watch: () => { throw new Error('SECRET-a'); },
    connect: () => { throw new Error('SECRET-b'); },
  });
  const { res, body, text } = await call(s);
  assert.equal(res.status, 200);
  assert.equal(body.watch.state, 'unknown');
  assert.deepEqual(body.games.map((g) => g.state), ['unknown', 'unknown']);
  assert.ok(!/SECRET|Error|stack/.test(text));
});

test('a hung probe is cut off and the rest still return in time', async () => {
  const s = setup({ watch: deafFetch, timeoutMs: 80 });
  const t = Date.now();
  const { body } = await call(s);
  assert.ok(Date.now() - t < 1000);
  assert.equal(body.watch.state, 'offline');
  assert.equal(body.games[0].state, 'online');
});

test('probes run in parallel, not one after the other', async () => {
  // Each probe only finishes once the other has started; run in sequence, the first would time out.
  let fetchStarted, connectStarted;
  const fetchGo = new Promise((r) => { fetchStarted = r; });
  const connectGo = new Promise((r) => { connectStarted = r; });
  const connect = fakeConnect(() => {
    connectStarted();
    const { socket } = fakeSocket({ steps: [statusFrame(REAL_STATUS)] });
    socket.opened = fetchGo.then(() => ({}));
    return socket;
  });
  const s = setup({ watch: async () => { fetchStarted(); await connectGo; return new Response('Healthy'); }, connect, timeoutMs: 150 });
  const { body } = await call(s);
  assert.equal(body.watch.state, 'online');
  assert.equal(body.games[0].state, 'online');
});

test('a total failure is a bare 503, never a stack trace', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const s = setup();
  s.deps.now = () => { throw new Error('SECRET-internal'); };
  const { res, text } = await call(s);
  assert.equal(res.status, 503);
  assert.equal(text, '{"error":"unavailable"}');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(logged.mock.callCount(), 1, 'the detail goes to the Worker log instead');
});

test('settleProbe turns a throw, a hang or a bad result into unknown', async () => {
  assert.equal((await settleProbe(() => { throw new Error('x'); }, 50)).state, 'unknown');
  assert.equal((await settleProbe(() => Promise.reject(new Error('x')), 50)).state, 'unknown');
  const t = Date.now();
  assert.equal((await settleProbe(() => new Promise(() => {}), 50)).state, 'unknown');
  assert.ok(Date.now() - t < 1000);
  assert.deepEqual(await settleProbe(() => ({ state: 'up', players: 3 }), 50), { state: 'unknown', ...NULLS });
  assert.deepEqual(await settleProbe(() => null, 50), { state: 'unknown', ...NULLS });
  assert.deepEqual(await settleProbe(() => ({ state: 'online', players: '2', maxPlayers: 20, version: 7 }), 50),
    { state: 'online', players: null, maxPlayers: 20, version: null });
  assert.deepEqual(await settleProbe(() => ({ state: 'offline', players: 2, maxPlayers: 20, version: 'x' }), 50),
    { state: 'offline', ...NULLS }, 'counts only for a server that answered');
});

// ---- no SSRF ----------------------------------------------------------------------

test('Zomboid is never probed; only the configured targets are contacted', async () => {
  const s = setup();
  await call(s);
  assert.deepEqual(s.connect.calls.map((c) => c.address), [{ hostname: 'game.homebknet.us', port: 25565 }]);
  assert.deepEqual(s.fetch.calls.map((c) => c.url), [WATCH_HEALTH_URL]);
});

test('nothing in the request changes what gets probed', async () => {
  const s = setup();
  await call(s, {
    path: '/status.json?host=127.0.0.1&port=22&url=http%3A%2F%2F169.254.169.254%2F&target=evil.example',
    headers: { 'x-forwarded-host': 'evil.example', 'x-target': 'evil.example:22', referer: 'https://evil.example/' },
  });
  assert.deepEqual(s.connect.calls.map((c) => c.address), [{ hostname: 'game.homebknet.us', port: 25565 }]);
  assert.deepEqual(s.fetch.calls.map((c) => c.url), [WATCH_HEALTH_URL]);
});

// ---- cache -------------------------------------------------------------------------

test('cache miss probes and stores under the synthetic key; a hit does not probe', async () => {
  const s = setup({ cache: fakeCache() });
  const first = await call(s);
  assert.deepEqual(probes(s), { fetch: 1, connect: 1 });
  assert.deepEqual(s.cache.log.put, [{ key: CACHE_KEY, cacheControl: 'public, max-age=30' }]);
  assert.equal(s.ctx.pending.length, 1, 'stored via waitUntil, off the response path');

  s.clock += 20000;
  const second = await call(s);
  assert.deepEqual(probes(s), { fetch: 1, connect: 1 }, 'served from cache');
  assert.equal(second.text, first.text);
  assert.equal(second.body.updated, '2026-10-25T18:30:00Z', 'updated stays the probe time');
});

test('the cache key ignores the request: query strings cannot force a probe', async () => {
  const s = setup({ cache: fakeCache() });
  await call(s);
  await call(s, { path: '/status.json?bust=1' });
  await call(s, { path: '/status.json?' + 'x'.repeat(500) });
  assert.deepEqual(probes(s), { fetch: 1, connect: 1 });
  assert.ok(s.cache.log.match.every((k) => k === CACHE_KEY));
});

test('a stale entry is a miss: probes again after CACHE_SECONDS', async () => {
  const s = setup({ cache: fakeCache() });
  await call(s);
  s.clock += 30000;
  await call(s);
  assert.deepEqual(probes(s), { fetch: 1, connect: 1 }, 'still fresh at exactly 30 s');
  s.clock += 1001;
  const third = await call(s);
  assert.deepEqual(probes(s), { fetch: 2, connect: 2 });
  assert.equal(third.body.updated, '2026-10-25T18:30:31Z');
});

test('CACHE_SECONDS sets the TTL, clamped to 30..60', async () => {
  const s = setup({ cache: fakeCache() });
  const env = { ...ENV, CACHE_SECONDS: '45' };
  await call(s, { env });
  assert.equal(s.cache.log.put[0].cacheControl, 'public, max-age=45');
  s.clock += 44000;
  await call(s, { env });
  assert.equal(probes(s).fetch, 1);
  s.clock += 2000;
  await call(s, { env });
  assert.equal(probes(s).fetch, 2);

  const cases = { '30': 30, '45': 45, '60': 60, '5': 30, '0': 30, '999': 60, '-5': 30, 'abc': 30, '': 30, '30s': 30, ' 40 ': 40, '1e3': 30 };
  for (const [raw, want] of Object.entries(cases)) assert.equal(cacheSeconds({ CACHE_SECONDS: raw }), want, JSON.stringify(raw));
  assert.equal(cacheSeconds({ CACHE_SECONDS: 50 }), 50);
  assert.equal(cacheSeconds({}), 30);
  assert.equal(cacheSeconds(undefined), 30);
});

test('a broken cache never breaks the response', async () => {
  const throwing = { match: async () => { throw new Error('cache down'); }, put: async () => { throw new Error('cache down'); } };
  const s = setup({ cache: throwing });
  const { res, body } = await call(s);
  assert.equal(res.status, 200);
  assert.equal(body.watch.state, 'online');

  const syncThrowing = { match() { throw new Error('x'); }, put() { throw new Error('x'); } };
  const s2 = setup({ cache: syncThrowing });
  assert.equal((await call(s2)).res.status, 200);
});

test('corrupt, foreign, future or stale-shaped cache entries are misses', async () => {
  const bad = [
    'not json',
    JSON.stringify({ v: 2, at: T0, watch: { state: 'online' }, games: [] }),
    JSON.stringify({ v: 1, at: T0, watch: { state: 'online' }, games: [{ id: 'mc-hardcore', state: 'online' }] }),
    JSON.stringify({ v: 1, at: T0, watch: { state: 'online' }, games: [{ id: 'zomboid' }, { id: 'mc-hardcore' }] }),
    JSON.stringify({ v: 1, at: T0 + 60000, watch: { state: 'online' }, games: [{ id: 'mc-hardcore' }, { id: 'zomboid' }] }),
    JSON.stringify({ v: 1, at: 'yesterday', watch: { state: 'online' }, games: [{ id: 'mc-hardcore' }, { id: 'zomboid' }] }),
  ];
  for (const body of bad) {
    const cache = fakeCache();
    cache.store.set(CACHE_KEY, { body, headers: [] });
    const s = setup({ cache });
    await call(s);
    assert.equal(probes(s).fetch, 1, body.slice(0, 60));
  }
});

test('a cached entry is re-validated before it is served', async () => {
  const cache = fakeCache();
  cache.store.set(CACHE_KEY, {
    body: JSON.stringify({ v: 1, at: T0, watch: { state: '<b>pwned</b>' }, games: [{ id: 'mc-hardcore', state: 'online', players: -3, maxPlayers: '20', version: 'x'.repeat(500) }, { id: 'zomboid', state: 'online' }] }),
    headers: [],
  });
  const s = setup({ cache });
  const { body } = await call(s);
  assert.equal(probes(s).fetch, 0, 'served from cache');
  assert.equal(body.watch.state, 'unknown');
  assert.deepEqual(body.games[0], { ...MC, state: 'online', ...NULLS });
});

test('the notice is read on every request, not cached with the probes', async () => {
  const s = setup({ cache: fakeCache() });
  await call(s, { env: { ...ENV, NOTICE_TEXT: 'First' } });
  const hit = await call(s, { env: { ...ENV, NOTICE_TEXT: 'Second', NOTICE_LEVEL: 'warn' } });
  assert.equal(probes(s).fetch, 1);
  assert.deepEqual(hit.body.notice, { text: 'Second', level: 'warn' });
  assert.equal((await call(s)).body.notice, null);
});

test('HEAD uses the same cache', async () => {
  const s = setup({ cache: fakeCache() });
  await call(s, { method: 'HEAD' });
  await call(s);
  assert.deepEqual(probes(s), { fetch: 1, connect: 1 });
});

// ---- stampede guard (one probe round per isolate at a time) ------------------------------

const slowWatch = (ms) => async () => { await sleep(ms); return new Response('Healthy'); };
const slowMc = (ms) => fakeConnect(() => {
  const { socket } = fakeSocket({ steps: [statusFrame(REAL_STATUS)] });
  socket.opened = sleep(ms).then(() => ({}));
  return socket;
});

test('50 concurrent requests on an empty cache share one probe round', async () => {
  const s = setup({ cache: fakeCache(), isolate: createIsolateState(), watch: slowWatch(40), connect: slowMc(40) });
  const results = await Promise.all(Array.from({ length: 50 }, () => call(s)));
  assert.deepEqual(probes(s), { fetch: 1, connect: 1 });
  assert.ok(results.every((r) => r.res.status === 200 && r.text === results[0].text));
  assert.equal(results[0].body.watch.state, 'online');
  assert.equal(results[0].body.games[0].state, 'online');
});

test('while the game PC is asleep, waiters get the slow round instead of probing again', async () => {
  const s = setup({ cache: fakeCache(), isolate: createIsolateState(), mc: { opened: 'hang' }, timeoutMs: 150 });
  const t = Date.now();
  const results = await Promise.all(Array.from({ length: 20 }, () => call(s)));
  assert.ok(Date.now() - t < 1500, 'no request waited past the round');
  assert.deepEqual(probes(s), { fetch: 1, connect: 1 });
  assert.ok(results.every((r) => r.body.games[0].state === 'offline'));
});

test('a repeat request is served from isolate memory without touching the Cache API', async () => {
  const s = setup({ cache: fakeCache(), isolate: createIsolateState() });
  await call(s);
  const matches = s.cache.log.match.length;
  s.clock += 10000;
  await call(s);
  assert.equal(s.cache.log.match.length, matches);
  assert.deepEqual(probes(s), { fetch: 1, connect: 1 });
});

test('isolate memory expires after CACHE_SECONDS like the cache does', async () => {
  const s = setup({ isolate: createIsolateState() });
  await call(s);
  s.clock += 30000;
  await call(s);
  assert.equal(probes(s).fetch, 1);
  s.clock += 1001;
  await call(s);
  assert.equal(probes(s).fetch, 2);
});

test('a waiter whose round never lands probes itself when there is still time', async () => {
  const iso = createIsolateState();
  iso.round = { since: T0 }; // a round that died with its request
  const s = setup({ isolate: iso, timeoutMs: 50 });
  const t = Date.now();
  const { body } = await call(s);
  assert.ok(Date.now() - t < 2000);
  assert.equal(probes(s).fetch, 1);
  assert.equal(body.watch.state, 'online');
});

test('a waiter with no time left answers unknown rather than probing again', async () => {
  const iso = createIsolateState();
  iso.round = { since: T0 };
  const s = setup({ isolate: iso, timeoutMs: 50, responseBudgetMs: 600, cache: fakeCache() });
  const { res, body } = await call(s);
  assert.equal(res.status, 200);
  assert.deepEqual(probes(s), { fetch: 0, connect: 0 });
  assert.equal(body.watch.state, 'unknown');
  assert.deepEqual(body.games.map((g) => g.state), ['unknown', 'unknown']);
  assert.equal(s.cache.log.put.length, 0, 'a guess is never cached');
  assert.equal(iso.snapshot, null);
});

test('a round that ends without a result releases its waiters early', async () => {
  const iso = createIsolateState();
  const round = { since: T0 };
  iso.round = round;
  setTimeout(() => { if (iso.round === round) iso.round = null; }, 120);
  const s = setup({ isolate: iso, timeoutMs: 2000 });
  const t = Date.now();
  await call(s);
  assert.ok(Date.now() - t < 1000, `waited ${Date.now() - t} ms`);
  assert.equal(probes(s).fetch, 1);
});

test('a stale round marker is ignored', async () => {
  const iso = createIsolateState();
  iso.round = { since: T0 - 60000 };
  const s = setup({ isolate: iso });
  const t = Date.now();
  await call(s);
  assert.ok(Date.now() - t < 300);
  assert.equal(probes(s).fetch, 1);
  assert.equal(iso.round, null, 'cleared once the new round finished');
});

// ---- methods and paths ------------------------------------------------------------

test('GET and HEAD answer; HEAD has the same headers and no body', async () => {
  const s = setup();
  const get = await call(s);
  const head = await call(s, { method: 'HEAD' });
  assert.equal(head.res.status, 200);
  assert.equal(head.res.body, null);
  assert.deepEqual([...head.res.headers], [...get.res.headers]);
});

test('other methods get 405 with Allow, and probe nothing', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const s = setup();
    const { res, body } = await call(s, { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
    assert.deepEqual(body, { error: 'method not allowed' });
    assert.deepEqual(probes(s), { fetch: 0, connect: 0 }, method);
  }
});

test('any other path is 404 and probes nothing', async () => {
  for (const path of ['/', '/status.json/', '/STATUS.JSON', '/status.jsonx', '/status', '/x/status.json', '/__status-cache/v1', '/status.json%00']) {
    for (const method of ['GET', 'POST']) {
      const s = setup();
      const { res } = await call(s, { path, method });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.deepEqual(probes(s), { fetch: 0, connect: 0 }, `${method} ${path}`);
    }
  }
});

// ---- notice ---------------------------------------------------------------------------

test('notice: empty or missing means null', () => {
  for (const env of [{}, undefined, { NOTICE_TEXT: '' }, { NOTICE_TEXT: '   \n\t ' }, { NOTICE_TEXT: 42 }, { NOTICE_TEXT: null }]) {
    assert.equal(parseNotice(env), null, JSON.stringify(env));
  }
});

test('notice: plain text up to 200 characters, info or warn', () => {
  assert.deepEqual(parseNotice({ NOTICE_TEXT: 'Planned maintenance tonight, 11 pm to midnight.' }),
    { text: 'Planned maintenance tonight, 11 pm to midnight.', level: 'info' });
  assert.deepEqual(parseNotice({ NOTICE_TEXT: '  Back at 9:30 pm  ', NOTICE_LEVEL: ' WARN ' }), { text: 'Back at 9:30 pm', level: 'warn' });
  assert.deepEqual(parseNotice({ NOTICE_TEXT: 'Line one\nline two\r\n\tthree' }), { text: 'Line one line two three', level: 'info' });
  assert.deepEqual(parseNotice({ NOTICE_TEXT: `Para${ch(0x2028)}graph${ch(0x2029)}break` }).text, 'Para graph break', 'Unicode line breaks fold too');
  assert.equal(parseNotice({ NOTICE_TEXT: 'a'.repeat(MAX_NOTICE_CHARS) }).text.length, 200);
  assert.equal(parseNotice({ NOTICE_TEXT: ch(0x1f3ac).repeat(200) }).text, ch(0x1f3ac).repeat(200), 'counted in characters, not UTF-16 units');
});

test('notice: &, < and > are plain text (the page sets it with textContent)', () => {
  for (const text of ['A & B < C', 'Back in < 1 hour & a bit, <3', '<b>Down</b> tonight', 'Fish &amp; chips', 'x > y']) {
    assert.deepEqual(parseNotice({ NOTICE_TEXT: text }), { text, level: 'info' }, text);
  }
});

test('notice: control, bidi or invisible characters, or too long, and it is dropped and logged', (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const bad = [
    'a'.repeat(201),
    ch(0x1f3ac).repeat(201),
    ...[0x00, 0x07, 0x0b, 0x0c, 0x1b, 0x7f, 0x85, 0x9f].map((cp) => `control ${ch(cp)} here`),
    ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c].map((cp) => `bidi ${ch(cp)} here`),
    ...[0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2064, 0xfeff, 0x00ad, 0x180e, 0x3164].map((cp) => `invisible ${ch(cp)} here`),
    ch(0x200b), // nothing but an invisible character
  ];
  for (const text of bad) {
    const cps = Array.from(text).filter((c) => c.codePointAt(0) > 0x7e || c.codePointAt(0) < 0x20).map((c) => c.codePointAt(0).toString(16));
    assert.equal(parseNotice({ NOTICE_TEXT: text }), null, `${text.length} chars, code points ${cps.slice(0, 2).join(',')}`);
  }
  assert.equal(warned.mock.callCount(), bad.length);
});

test('notice: an unknown level falls back to info', (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const level of ['error', 'warning', '', undefined, 3]) {
    assert.equal(parseNotice({ NOTICE_TEXT: 'Hi', NOTICE_LEVEL: level }).level, 'info', String(level));
  }
});

test('notice reaches the document', async () => {
  const s = setup();
  const { body } = await call(s, { env: { ...ENV, NOTICE_TEXT: 'Streaming is paused while a drive is checked.', NOTICE_LEVEL: 'warn' } });
  assert.deepEqual(body.notice, { text: 'Streaming is paused while a drive is checked.', level: 'warn' });
});

// ---- headers --------------------------------------------------------------------------

test('every response carries the JSON and security headers, and nothing for other origins', async (t) => {
  t.mock.method(console, 'error', () => {});
  const s = setup();
  const broken = setup();
  broken.deps.now = () => { throw new Error('x'); };
  const responses = {
    200: (await call(s)).res,
    'HEAD 200': (await call(s, { method: 'HEAD' })).res,
    404: (await call(s, { path: '/nope' })).res,
    405: (await call(s, { method: 'POST' })).res,
    503: (await call(broken)).res,
  };
  for (const [name, res] of Object.entries(responses)) {
    for (const [k, v] of Object.entries(RESPONSE_HEADERS)) assert.equal(res.headers.get(k), v, `${name}: ${k}`);
    for (const k of ['access-control-allow-origin', 'set-cookie', 'server-timing']) assert.equal(res.headers.get(k), null, `${name}: ${k}`);
  }
  assert.equal(responses[200].headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(responses[200].headers.get('cache-control'), 'no-store');
  assert.equal(responses[200].headers.get('x-content-type-options'), 'nosniff');
  assert.equal(responses[200].headers.get('referrer-policy'), 'no-referrer');
});
