// The Worker's real output, checked against what the homepage expects:
//   1. key-by-key and type-by-type against every site fixture (always runs);
//   2. fed through the site's own status.js in jsdom (runs when site/tools has jsdom installed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleRequest } from '../src/handler.js';
import { statusFrame, REAL_STATUS, fakeSocket, fakeFetch } from './helpers/fakes.mjs';
import { SITE } from './helpers/site.mjs';

const OWNER = 'Testname';

let JSDOM = null;
try {
  ({ JSDOM } = createRequire(path.join(SITE, 'tools', 'package.json'))('jsdom'));
} catch {
  // not installed; the jsdom tests skip
}
const NO_JSDOM = JSDOM ? false : `jsdom is not installed: npm install in ${path.join(SITE, 'tools')}`;

// ---- scenarios, produced by the real handler ------------------------------------------

const withoutOnline = { ...REAL_STATUS, players: { max: 20 } };
const SCENARIOS = {
  normal: { watch: () => new Response('Healthy'), mc: { steps: [statusFrame(REAL_STATUS)] }, env: {} },
  badnight: { watch: () => new Response('Bad gateway', { status: 502 }), mc: { opened: 'reject' }, env: {} },
  maintenance: {
    watch: () => new Response('Healthy'),
    mc: { steps: [statusFrame(withoutOnline)] },
    env: { NOTICE_TEXT: 'Planned maintenance tonight, 11 pm to midnight.', NOTICE_LEVEL: 'info' },
  },
};

async function workerResponse(name, now = () => Date.now(), env = null) {
  const sc = SCENARIOS[name];
  const deps = {
    fetch: fakeFetch(sc.watch),
    connect: () => fakeSocket(sc.mc).socket,
    cache: null,
    now,
    timeoutMs: 200,
  };
  return handleRequest(new Request('https://homebknet.us/status.json', { headers: { accept: 'application/json' } }), env || sc.env, { waitUntil() {} }, deps);
}

// The type of every value, keeping keys and their order.
function shape(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

for (const name of Object.keys(SCENARIOS)) {
  test(`key-by-key and type-by-type equal to site/fixtures/status.${name}.json`, async () => {
    const fixture = JSON.parse(await readFile(path.join(SITE, 'fixtures', `status.${name}.json`), 'utf8'));
    const ours = await (await workerResponse(name)).json();
    assert.deepEqual(JSON.stringify(shape(ours)), JSON.stringify(shape(fixture)), 'same keys, same order, same types');
    assert.deepEqual(ours.games.map((g) => [g.id, g.name, g.address]), fixture.games.map((g) => [g.id, g.name, g.address]));
    assert.match(ours.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(Number.isFinite(Date.parse(ours.updated)));
  });
}

test('the normal scenario matches the normal fixture value for value, apart from the time and Zomboid', async () => {
  const fixture = JSON.parse(await readFile(path.join(SITE, 'fixtures', 'status.normal.json'), 'utf8'));
  const ours = await (await workerResponse('normal')).json();
  assert.deepEqual(ours.watch, fixture.watch);
  assert.deepEqual(ours.games[0], fixture.games[0]);
  // The fixture shows Zomboid asleep; the Worker can't see it (UDP), so it says unknown.
  assert.deepEqual({ ...ours.games[1], state: 'offline' }, fixture.games[1]);
  assert.equal(ours.notice, fixture.notice);
});

// ---- the site's status.js, in jsdom ---------------------------------------------------------

let out, html, script;
before(async () => {
  if (!JSDOM) return;
  out = await mkdtemp(path.join(tmpdir(), 'hb-worker-site-'));
  const res = spawnSync(process.execPath, [path.join(SITE, 'build.mjs')], {
    env: { ...process.env, OWNER_FIRST_NAME: OWNER, CONTACT_EMAIL: 'hello@example.com', OUTPOST_URL: '', PORTFOLIO_URL: '', OUT_DIR: out },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  html = await readFile(path.join(out, 'index.html'), 'utf8');
  const js = (await readdir(path.join(out, 'assets'))).find((f) => /^status\.[0-9a-f]{10}\.js$/.test(f));
  script = await readFile(path.join(out, 'assets', js), 'utf8');
});
after(() => (out ? rm(out, { recursive: true, force: true }) : undefined));

// Loads the built page with fetch('/status.json') answered by the Worker's real Response,
// waits for status.js to render it, runs `check`, and always closes the window (its poll timer
// would otherwise keep the process alive).
async function withPage(respond, check) {
  const dom = new JSDOM(html, { url: 'https://homebknet.us/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  try {
    const requested = [];
    w.fetch = async (url, init) => {
      requested.push({ url, cache: init && init.cache });
      return respond();
    };
    w.eval(script);
    const d = w.document;
    const q = (s) => d.querySelector(s);
    const rendered = () => requested.length > 0 && !/Checking/.test(q('#now-updated').textContent);
    for (let i = 0; i < 300 && !rendered(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(rendered(), 'status.js fetched and rendered');
    const chip = (sel) => { const c = q(sel); return { state: c.getAttribute('data-state'), word: c.querySelector('.chip-word').textContent }; };
    await check({ q, chip, requested });
  } finally {
    w.close();
  }
}

test('status.js renders the Worker\'s normal night', { skip: NO_JSDOM }, async () => {
  await withPage(() => workerResponse('normal'), async (p) => {
    assert.deepEqual(p.requested, [{ url: '/status.json', cache: 'no-store' }]);
    assert.deepEqual(p.chip('[data-svc-chip="watch"]'), { state: 'online', word: 'Watch: Online' });
    assert.equal(p.q('.now-row[data-svc="watch"] [data-detail]').textContent, 'Movies and shows');
    const mc = p.q('article[data-game="mc-hardcore"]');
    assert.equal(mc.querySelector('[data-chip]').getAttribute('data-state'), 'online');
    assert.equal(mc.querySelector('[data-well-text]').textContent, '2 of 20 playing');
    assert.equal(mc.querySelector('[data-meter]').hidden, false);
    assert.equal(mc.querySelector('[data-meter-fill]').style.width, '10%');
    assert.deepEqual(p.chip('article[data-game="zomboid"] [data-chip]'), { state: 'unknown', word: 'Unknown' });
    assert.equal(p.q('article[data-game="zomboid"] [data-well-text]').textContent, 'Can’t check this one right now. It might still be running.');
    assert.equal(p.q('#now-updated').textContent, 'Updated just now');
    assert.equal(p.q('#now-na').hidden, true);
    assert.equal(p.q('#watch-alert').hidden, true);
    assert.equal(p.q('#notice').hidden, true);
  });
});

test('status.js renders the Worker\'s bad night: Watch down, Minecraft asleep', { skip: NO_JSDOM }, async () => {
  await withPage(() => workerResponse('badnight'), async (p) => {
    assert.deepEqual(p.chip('[data-svc-chip="watch"]'), { state: 'offline', word: 'Watch: Offline' });
    assert.equal(p.q('#watch-alert').hidden, false);
    assert.equal(p.q('#hero-down').hidden, false);
    assert.deepEqual(p.chip('article[data-game="mc-hardcore"] [data-chip]'), { state: 'asleep', word: 'Asleep' });
    assert.equal(p.q('article[data-game="mc-hardcore"] [data-well-text]').textContent, `Asleep. Ask ${OWNER} to start it.`);
    assert.equal(p.q('article[data-game="mc-hardcore"] [data-meter]').hidden, true);
  });
});

test('status.js shows the Worker\'s notice, and hides the count it can\'t trust', { skip: NO_JSDOM }, async () => {
  await withPage(() => workerResponse('maintenance'), async (p) => {
    assert.equal(p.q('#notice').hidden, false);
    assert.equal(p.q('#notice').getAttribute('data-level'), 'info');
    assert.equal(p.q('#notice-text').textContent, 'Planned maintenance tonight, 11 pm to midnight.');
    const mc = p.q('article[data-game="mc-hardcore"]');
    assert.equal(mc.querySelector('[data-well-text]').textContent, 'Online and ready');
    assert.equal(mc.querySelector('[data-meter]').hidden, true);
  });
});

test('status.js shows a notice with &, < and > as literal text, never as markup', { skip: NO_JSDOM }, async () => {
  const text = '<b>Down</b> & back in < 1 hour <img src=x onerror=alert(1)>';
  await withPage(() => workerResponse('normal', undefined, { NOTICE_TEXT: text, NOTICE_LEVEL: 'warn' }), async (p) => {
    assert.equal(p.q('#notice').hidden, false);
    assert.equal(p.q('#notice').getAttribute('data-level'), 'warn');
    assert.equal(p.q('#notice-text').textContent, text);
    assert.equal(p.q('#notice-text').children.length, 0, 'no elements were created');
    assert.equal(p.q('#notice img'), null);
  });
});

test('status.js treats the Worker\'s last-resort 503 as unavailable', { skip: NO_JSDOM }, async (t) => {
  t.mock.method(console, 'error', () => {});
  await withPage(() => workerResponse('normal', () => { throw new Error('x'); }), async (p) => {
    for (const sel of ['[data-svc-chip="watch"]', 'article[data-game="mc-hardcore"] [data-chip]']) assert.equal(p.chip(sel).state, 'na');
    assert.equal(p.q('#now-updated').textContent, 'Live status couldn’t load');
  });
});
