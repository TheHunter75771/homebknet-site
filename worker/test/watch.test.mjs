// Watch (Jellyfin through the tunnel): every status code, the body check, timeouts, redirects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeWatch, WATCH_HEALTH_URL } from '../src/watch.js';
import { fakeFetch, deafFetch } from './helpers/fakes.mjs';

const run = (fetch, timeoutMs = 80) => probeWatch({ fetch, timeoutMs });
const answer = (body, status = 200, headers = {}) => fakeFetch(() => new Response(body, { status, headers }));

test('the URL is the Jellyfin health endpoint under /watch', () => {
  assert.equal(WATCH_HEALTH_URL, 'https://watch.homebknet.us/watch/health');
});

test('200 Healthy: online, with one GET that does not follow redirects', async () => {
  const fetch = answer('Healthy', 200, { 'content-type': 'text/plain; charset=utf-8' });
  assert.deepEqual(await run(fetch), { state: 'online' });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, WATCH_HEALTH_URL);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
});

test('Healthy with surrounding whitespace still counts', async () => {
  assert.equal((await run(answer('Healthy\n'))).state, 'online');
  assert.equal((await run(answer('  Healthy  '))).state, 'online');
});

test('200 with any other body: offline', async () => {
  for (const body of ['Degraded', 'Unhealthy', 'healthy', 'Healthy!', 'Healthy Healthy', '', '<!doctype html><title>Sign in</title>', 'Healthy' + ' '.repeat(300)]) {
    assert.equal((await run(answer(body))).state, 'offline', JSON.stringify(body.slice(0, 40)));
  }
});

test('a huge 200 body is not read past the cap', async () => {
  let pulled = 0;
  const body = new ReadableStream({
    pull(c) {
      pulled++;
      if (pulled > 1000) { c.close(); return; }
      c.enqueue(new TextEncoder().encode('Healthy'.repeat(20)));
    },
  });
  assert.equal((await run(fakeFetch(() => new Response(body)))).state, 'offline');
  assert.ok(pulled < 10, `read ${pulled} chunks`);
});

test('every non-200 status: offline', async () => {
  for (const status of [201, 204, 206, 400, 401, 403, 404, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 530]) {
    const body = status === 204 ? null : 'Healthy';
    assert.equal((await run(answer(body, status))).state, 'offline', `HTTP ${status}`);
  }
});

test('a redirect is reported, not followed', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const fetch = fakeFetch(() => new Response(null, { status, headers: { location: 'https://elsewhere.example/health' } }));
    assert.equal((await run(fetch)).state, 'offline', `HTTP ${status}`);
    assert.equal(fetch.calls.length, 1, 'only the one request');
    assert.equal(fetch.calls[0].init.redirect, 'manual');
  }
});

test('an opaque redirect (status 0) is offline', async () => {
  const fetch = fakeFetch(() => ({ status: 0, type: 'opaqueredirect', body: null }));
  assert.equal((await run(fetch)).state, 'offline');
});

test('no answer within the timeout: offline, and the request is aborted', async () => {
  let signal;
  const fetch = (url, init) => { signal = init.signal; return new Promise(() => {}); };
  const t = Date.now();
  assert.equal((await run(fetch, 60)).state, 'offline');
  assert.ok(Date.now() - t < 1000);
  assert.equal(signal.aborted, true);
});

test('a fetch that ignores the abort is still cut off at the timeout', async () => {
  const t = Date.now();
  assert.equal((await run(deafFetch, 60)).state, 'offline');
  assert.ok(Date.now() - t < 1000);
});

test('a fetch that rejects on abort: offline', async () => {
  const fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  assert.equal((await run(fetch, 60)).state, 'offline');
});

test('a body that stalls past the timeout: offline', async () => {
  const body = new ReadableStream({ pull() { return new Promise(() => {}); } });
  assert.equal((await run(fakeFetch(() => new Response(body)), 60)).state, 'offline');
});

test('the origin dropping the body mid-stream: offline', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('Heal')); c.error(new Error('reset')); } });
  assert.equal((await run(fakeFetch(() => new Response(body)))).state, 'offline');
});

test('fetch() itself failing is the Worker\'s fault: unknown', async () => {
  assert.equal((await run(async () => { throw new TypeError('Too many subrequests'); })).state, 'unknown');
  assert.equal((await run(() => { throw new TypeError('sync throw'); })).state, 'unknown');
  assert.equal((await run(async () => undefined)).state, 'unknown');
  assert.equal((await run(async () => ({ status: 'ok' }))).state, 'unknown');
});
