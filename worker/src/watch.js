/*
 * Watch (Jellyfin) health, read through the public Cloudflare tunnel.
 *
 * Jellyfin runs with the base URL /watch, so its health endpoint is /watch/health and answers
 * the plain-text body "Healthy" when all is well.
 *
 *   200 + "Healthy"                          online
 *   any other status (502/503/530 from the   offline
 *   tunnel, 3xx, 4xx, ...) or any other body
 *   no answer within the timeout             offline
 *   fetch() itself throws                    unknown  (the edge turns origin and tunnel failures
 *                                                      into HTTP 5xx responses, so a thrown fetch
 *                                                      is the Worker's own subrequest failing)
 *
 * Redirects are never followed: a 3xx is reported as offline, wherever it points.
 */

export const WATCH_HEALTH_URL = 'https://watch.homebknet.us/watch/health';
export const WATCH_TIMEOUT_MS = 4000;
export const MAX_HEALTH_BODY_BYTES = 256; // "Healthy" is 7 bytes; anything this big isn't it

const TIMED_OUT = Symbol('timed out');
const state = (s) => ({ state: s });

function discardBody(res) {
  try {
    const p = res.body && typeof res.body.cancel === 'function' ? res.body.cancel() : null;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // nothing to free
  }
}

// Reads at most `max` bytes of the body as UTF-8. Returns null if the body is longer.
async function readSmallText(res, max) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = typeof res.text === 'function' ? String(await res.text()) : '';
    return new TextEncoder().encode(text).length > max ? null : text;
  }
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      Promise.resolve().then(() => reader.cancel()).catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function probeWatch({ fetch, url = WATCH_HEALTH_URL, timeoutMs = WATCH_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  const check = (async () => {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { accept: 'text/plain' },
      });
    } catch {
      return state(ctrl.signal.aborted ? 'offline' : 'unknown');
    }
    if (!res || typeof res.status !== 'number') return state('unknown');
    if (res.status !== 200) {
      discardBody(res);
      return state('offline');
    }
    let text;
    try {
      text = await readSmallText(res, MAX_HEALTH_BODY_BYTES);
    } catch {
      return state('offline'); // the origin dropped the body mid-stream
    }
    return state(text !== null && text.trim() === 'Healthy' ? 'online' : 'offline');
  })();
  check.catch(() => {});

  try {
    const outcome = await Promise.race([check, deadline]);
    return outcome === TIMED_OUT ? state('offline') : outcome;
  } catch {
    return state('unknown');
  } finally {
    clearTimeout(timer);
  }
}
