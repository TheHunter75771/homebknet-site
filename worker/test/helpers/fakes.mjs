// Offline stand-ins for the Workers runtime: TCP sockets, fetch, the Cache API and ctx.
import { encodeVarInt } from '../../src/minecraft.js';

export const enc = (s) => new TextEncoder().encode(s);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// A status response frame as a server sends it.
export function statusFrame(payload) {
  const str = enc(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const body = concat(encodeVarInt(0x00), encodeVarInt(str.length), str);
  return concat(encodeVarInt(body.length), body);
}

// What a vanilla/Fabric server sends, favicon and all.
export const REAL_STATUS = {
  version: { name: '26.1.2', protocol: 775 },
  enforcesSecureChat: true,
  description: { text: '', extra: [{ text: 'Hardcore', color: 'red', bold: true }, { text: ' - one life, shared' }] },
  players: {
    max: 20,
    online: 2,
    sample: [
      { name: 'Alex', id: '00000000-0000-0000-0000-000000000001' },
      { name: 'Steve', id: '00000000-0000-0000-0000-000000000002' },
    ],
  },
  favicon: 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(600),
};

export function chunk(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

// A scripted TCP socket shaped like cloudflare:sockets.
//   opened: 'ok' | 'reject' (refused) | 'hang' (SYN never answered)
//   write:  'ok' | 'reject' (reset while sending)
//   steps:  what each read() returns in turn: bytes, 'eof', 'reset' or 'hang'
//   end:    what read() does once the steps run out
export function fakeSocket({ opened = 'ok', write = 'ok', steps = [], end = 'eof' } = {}) {
  const log = { written: [], closeCalls: 0, reads: 0 };
  const waiters = [];
  let isClosed = false;
  const hang = () => new Promise((_, reject) => {
    if (isClosed) reject(new Error('socket closed'));
    else waiters.push(reject);
  });
  const rejected = (msg) => { const p = Promise.reject(new Error(msg)); p.catch(() => {}); return p; };
  const openedP = opened === 'ok' ? Promise.resolve({}) : opened === 'reject' ? rejected('connection refused') : hang();
  openedP.catch(() => {});
  const queue = [...steps];
  const socket = {
    opened: openedP,
    closed: new Promise(() => {}),
    writable: {
      getWriter: () => ({
        async write(bytes) {
          if (write === 'reject') throw new Error('connection reset');
          log.written.push(Uint8Array.from(bytes));
        },
        releaseLock() {},
      }),
    },
    readable: {
      getReader: () => ({
        async read() {
          log.reads++;
          if (isClosed) throw new Error('socket closed');
          const step = queue.length ? queue.shift() : end;
          if (step === 'eof') return { done: true, value: undefined };
          if (step === 'reset') throw new Error('connection reset');
          if (step === 'hang') return hang();
          return { done: false, value: step };
        },
        releaseLock() {},
        async cancel() {},
      }),
    },
    close() {
      log.closeCalls++;
      isClosed = true;
      waiters.splice(0).forEach((reject) => reject(new Error('socket closed')));
      return Promise.resolve();
    },
  };
  return { socket, log };
}

// connect() that records its arguments and hands out sockets from `make`.
export function fakeConnect(make) {
  const calls = [];
  const fn = (address, options) => {
    calls.push({ address, options });
    return make(address, options);
  };
  fn.calls = calls;
  return fn;
}

// fetch() that records its arguments and answers with `answer(url, init)`.
export function fakeFetch(answer) {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ url: String(input), init });
    return answer(String(input), init);
  };
  fn.calls = calls;
  return fn;
}

// A fetch that never answers and ignores its abort signal.
export const deafFetch = () => new Promise(() => {});

// caches.default, with no TTL of its own (the handler checks freshness itself).
export function fakeCache() {
  const store = new Map();
  const log = { match: [], put: [] };
  const keyOf = (k) => (typeof k === 'string' ? k : k.url);
  return {
    store,
    log,
    async match(key) {
      log.match.push(keyOf(key));
      const e = store.get(keyOf(key));
      return e ? new Response(e.body, { headers: e.headers }) : undefined;
    },
    async put(key, res) {
      log.put.push({ key: keyOf(key), cacheControl: res.headers.get('cache-control') });
      store.set(keyOf(key), { body: await res.text(), headers: [...res.headers] });
    },
  };
}

export function fakeCtx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(p); }, flush: () => Promise.all(pending) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
