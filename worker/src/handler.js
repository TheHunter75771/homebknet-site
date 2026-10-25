/*
 * GET/HEAD /status.json for the homebknet.us homepage (consumer: the site's src/assets/status.js).
 *
 *   { "updated": ISO 8601, "watch": { "state": S },
 *     "games": [{ "id", "name", "address", "state": S, "players", "maxPlayers", "version" }],
 *     "notice": null | { "text", "level": "info" | "warn" } }
 *
 * S is online | offline | starting | unknown. A probe round is reused for CACHE_SECONDS, first
 * from this isolate's memory, then from the data center's Cache API under a fixed key. While a
 * round is running, other requests in the same isolate wait for it instead of probing again.
 * The notice comes from Worker vars on every request, so it changes as soon as it's deployed.
 */
import { GAMES, parseAddress } from './games.js';
import { probeWatch } from './watch.js';
import { pingMinecraft, cleanCount, cleanVersion, PING_TIMEOUT_MS } from './minecraft.js';

export const STATUS_PATH = '/status.json';
export const CACHE_KEY = 'https://homebknet.us/__status-cache/v1'; // synthetic; never built from a request
export const STATES = Object.freeze(['online', 'offline', 'starting', 'unknown']);
export const DEFAULT_CACHE_SECONDS = 30;
export const MIN_CACHE_SECONDS = 30;
export const MAX_CACHE_SECONDS = 60;
export const MAX_NOTICE_CHARS = 200;
export const PROBE_GRACE_MS = 500; // a probe that outlives its own timeout by this much is cut off
export const RESPONSE_BUDGET_MS = 5500; // status.js aborts at 6 s; stay under it with a margin
const WAIT_POLL_MS = 50;
const WAIT_MARGIN_MS = 250;

// The JSON-relevant subset of the site's src/_headers, plus the two headers status.js relies on.
export const RESPONSE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
});

const json = (status, body, extra = {}, head = false) =>
  new Response(head ? null : body, { status, headers: { ...RESPONSE_HEADERS, ...extra } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- vars ------------------------------------------------------------------------

export function cacheSeconds(env) {
  const raw = env && env.CACHE_SECONDS;
  const n = typeof raw === 'string' && /^\s*\d{1,6}\s*$/.test(raw) ? Number(raw) : (Number.isInteger(raw) ? raw : NaN);
  if (!Number.isFinite(n)) return DEFAULT_CACHE_SECONDS;
  return Math.min(MAX_CACHE_SECONDS, Math.max(MIN_CACHE_SECONDS, n));
}

// A character class from code points, written as numbers so the source itself stays free of
// invisible characters.
const hex = (cp) => '\\u' + cp.toString(16).padStart(4, '0');
const charClass = (ranges) => new RegExp('[' + ranges.map(([a, b]) => hex(a) + (b ? '-' + hex(b) : '')).join('') + ']', 'u');

// Control, bidi and invisible characters. Tab, line feed, carriage return and the Unicode line and
// paragraph separators are allowed because they fold to a space.
export const NOTICE_FORBIDDEN = charClass([
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x009f], // C0 and C1 controls
  [0x00ad], [0x034f], [0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180e], // soft hyphen, fillers, ALM
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x202a, 0x202e], [0x2066, 0x2069], // bidi embeddings, overrides, isolates
  [0x2060, 0x2064], [0x3164], [0xfeff], [0xffa0], [0xfff9, 0xfffb], // word joiner, invisible operators, BOM
]);

// NOTICE_TEXT must be plain text of at most 200 characters. It reaches the page through
// textContent, so &, < and > are just characters. Line breaks and runs of spaces fold to one
// space. Anything that fails the rules drops the notice (null) rather than publishing something
// half-right; the reason goes to the Worker log (wrangler tail).
export function parseNotice(env) {
  const raw = env && env.NOTICE_TEXT;
  if (typeof raw !== 'string') return null;
  let problem = '';
  if (NOTICE_FORBIDDEN.test(raw)) problem = 'has control, bidi or invisible characters';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!problem && !text) return null;
  if (!problem && Array.from(text).length > MAX_NOTICE_CHARS) problem = `is over ${MAX_NOTICE_CHARS} characters`;
  if (problem) {
    console.warn(`NOTICE_TEXT ignored: it ${problem}.`);
    return null;
  }
  const lvl = typeof env.NOTICE_LEVEL === 'string' ? env.NOTICE_LEVEL.trim().toLowerCase() : '';
  if (lvl && lvl !== 'info' && lvl !== 'warn') console.warn('NOTICE_LEVEL must be "info" or "warn"; using "info".');
  return { text, level: lvl === 'warn' ? 'warn' : 'info' };
}

// ---- probes ------------------------------------------------------------------------

function normalizeProbe(r) {
  const s = r && STATES.includes(r.state) ? r.state : 'unknown';
  const answered = s === 'online' || s === 'starting';
  return {
    state: s,
    players: answered ? cleanCount(r.players) : null,
    maxPlayers: answered ? cleanCount(r.maxPlayers) : null,
    version: answered ? cleanVersion(r.version) : null,
  };
}

// Runs one probe so that it can neither throw nor hang: a failure or overrun is "unknown".
export async function settleProbe(run, limitMs) {
  let timer;
  try {
    const cutoff = new Promise((resolve) => { timer = setTimeout(() => resolve(null), limitMs); });
    const work = Promise.resolve().then(run);
    work.catch(() => {});
    return normalizeProbe(await Promise.race([work, cutoff]));
  } catch {
    return normalizeProbe(null);
  } finally {
    clearTimeout(timer);
  }
}

async function probeGame(game, connect, timeoutMs) {
  if (game.probe === 'minecraft-java') {
    const { hostname, port } = parseAddress(game.address);
    return pingMinecraft({ connect, hostname, port, timeoutMs });
  }
  return { state: 'unknown' }; // 'none': nothing a Worker can ask (see games.js)
}

const roundLimit = (deps) => (deps.timeoutMs ?? PING_TIMEOUT_MS) + PROBE_GRACE_MS;

// One probe round. Watch and every game run in parallel: status.js gives up after 6 s, so a
// cold-cache request must finish in one probe timeout (4 s), not the sum of them.
export async function probeAll(deps) {
  const at = deps.now();
  const timeoutMs = deps.timeoutMs ?? PING_TIMEOUT_MS;
  const limit = roundLimit(deps);
  const [watch, ...games] = await Promise.all([
    settleProbe(() => probeWatch({ fetch: deps.fetch, timeoutMs }), limit),
    ...GAMES.map((g) => settleProbe(() => probeGame(g, deps.connect, timeoutMs), limit)),
  ]);
  return {
    v: 1,
    at,
    watch: { state: watch.state },
    games: GAMES.map((g, i) => ({ id: g.id, ...games[i] })),
  };
}

// What to say when there was no time to find out: everything unknown. Never cached.
function unknownSnapshot(at) {
  return { v: 1, at, watch: { state: 'unknown' }, games: GAMES.map((g) => ({ id: g.id, ...normalizeProbe(null) })) };
}

// ---- reuse: isolate memory, then the Cache API ----------------------------------------------

const isFresh = (at, now, ttlSeconds) => {
  const age = now - at;
  return age >= 0 && age <= ttlSeconds * 1000;
};

// Per-isolate state, shared by the requests one isolate serves. It holds plain data only: the
// runtime doesn't let one request use another request's I/O or settle its promises, so a waiting
// request polls this on its own timers instead of awaiting the other request's probe.
export function createIsolateState() {
  return { snapshot: null, round: null };
}

// A cached snapshot is used only if it's ours, fresh, and for the current game list.
function readSnapshot(text, now, ttlSeconds) {
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return null;
  }
  if (!s || s.v !== 1 || !Number.isFinite(s.at) || !s.watch || !Array.isArray(s.games)) return null;
  if (!isFresh(s.at, now, ttlSeconds)) return null;
  if (s.games.length !== GAMES.length || s.games.some((g, i) => !g || g.id !== GAMES[i].id)) return null;
  return {
    v: 1,
    at: s.at,
    watch: { state: normalizeProbe(s.watch).state },
    games: s.games.map((g) => ({ id: g.id, ...normalizeProbe(g) })),
  };
}

async function readCache(deps, ttlSeconds) {
  if (!deps.cache) return null;
  try {
    const hit = await deps.cache.match(CACHE_KEY);
    return hit ? readSnapshot(await hit.text(), deps.now(), ttlSeconds) : null;
  } catch {
    return null; // cache trouble is not an outage: probe instead
  }
}

function writeCache(deps, ctx, snap, ttlSeconds) {
  if (!deps.cache) return;
  const stored = new Response(JSON.stringify(snap), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttlSeconds}` },
  });
  const put = Promise.resolve().then(() => deps.cache.put(CACHE_KEY, stored)).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
}

// Waits for the round already running in this isolate, until that round's own deadline.
// Returns { snap, waitedMs }; snap is null if the round ended (or died) without a fresh result.
async function waitForRound(iso, deps, ttlSeconds) {
  const round = iso.round;
  const budget = Math.max(0, round.since + roundLimit(deps) + WAIT_MARGIN_MS - deps.now());
  const polls = Math.ceil(budget / WAIT_POLL_MS);
  for (let i = 1; i <= polls; i++) {
    await sleep(WAIT_POLL_MS);
    if (iso.snapshot && isFresh(iso.snapshot.at, deps.now(), ttlSeconds)) return { snap: iso.snapshot, waitedMs: i * WAIT_POLL_MS };
    if (iso.round !== round) return { snap: null, waitedMs: i * WAIT_POLL_MS };
  }
  return { snap: null, waitedMs: polls * WAIT_POLL_MS };
}

async function getSnapshot(deps, ctx, ttlSeconds) {
  const iso = deps.isolate || null;
  if (iso && iso.snapshot && isFresh(iso.snapshot.at, deps.now(), ttlSeconds)) return iso.snapshot;

  const cached = await readCache(deps, ttlSeconds);
  if (cached) {
    if (iso) iso.snapshot = cached;
    return cached;
  }

  // Someone in this isolate is already probing: wait for their result rather than probe again.
  // If it never arrives, probe only if that still fits under status.js's timeout; otherwise
  // answer "unknown" now, which the page shows as "Can't check right now".
  if (iso && iso.round && deps.now() - iso.round.since < roundLimit(deps)) {
    const { snap, waitedMs } = await waitForRound(iso, deps, ttlSeconds);
    if (snap) return snap;
    if (waitedMs + roundLimit(deps) > (deps.responseBudgetMs ?? RESPONSE_BUDGET_MS)) return unknownSnapshot(deps.now());
  }

  const round = { since: deps.now() };
  if (iso) iso.round = round;
  let snap;
  try {
    snap = await probeAll(deps);
  } finally {
    if (iso && iso.round === round) iso.round = null;
  }
  if (iso) iso.snapshot = snap;
  writeCache(deps, ctx, snap, ttlSeconds);
  return snap;
}

// ---- response ------------------------------------------------------------------------

const isoSeconds = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export function toDocument(snap, notice) {
  return {
    updated: isoSeconds(snap.at),
    watch: { state: snap.watch.state },
    games: GAMES.map((g, i) => {
      const r = snap.games[i];
      return { id: g.id, name: g.name, address: g.address, state: r.state, players: r.players, maxPlayers: r.maxPlayers, version: r.version };
    }),
    notice,
  };
}

export async function handleRequest(request, env, ctx, deps) {
  try {
    const url = new URL(request.url);
    const method = String(request.method).toUpperCase();
    const head = method === 'HEAD';
    if (url.pathname !== STATUS_PATH) return json(404, '{"error":"not found"}', {}, head);
    if (method !== 'GET' && method !== 'HEAD') return json(405, '{"error":"method not allowed"}', { allow: 'GET, HEAD' });

    const snap = await getSnapshot(deps, ctx, cacheSeconds(env));
    return json(200, JSON.stringify(toDocument(snap, parseNotice(env))), {}, head);
  } catch (err) {
    // Last resort. Details stay in the Worker log; the page just sees "unavailable".
    console.error('status: unexpected failure', err);
    return json(503, '{"error":"unavailable"}');
  }
}
