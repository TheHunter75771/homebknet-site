// Builds the site into a temp folder, then runs status.js in jsdom against each status scenario.
// Also checks the build itself: the privacy guard, the atomic dist/ swap and the sample preview.
// Run: cd tools && npm ci && npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OWNER = 'Testname';
const ENV = { ...process.env, OWNER_FIRST_NAME: OWNER, CONTACT_EMAIL: 'hello@example.com', OUTPOST_URL: '', PORTFOLIO_URL: '' };
delete ENV.OUT_DIR;

let work, out, html, script;
let serial = 0;

// Every build in this file writes under one temp folder that is removed at the end, never to ROOT/dist.
const fresh = async (name = 'out') => {
  const dir = path.join(work, `${name}-${++serial}`);
  await mkdir(dir);
  return dir;
};

// Runs build.mjs from `root` (default: this repo). With `dir`, OUT_DIR is set to it.
function build(env, dir, { root = ROOT, args = [] } = {}) {
  const e = { ...env };
  if (dir) e.OUT_DIR = dir;
  return spawnSync(process.execPath, [path.join(root, 'build.mjs'), ...args], { cwd: root, env: e, encoding: 'utf8' });
}

// A throwaway copy of the site, for tests that change content or use the default output folders.
async function siteCopy() {
  const dir = await fresh('site');
  for (const p of ['build.mjs', 'src', 'content', 'fixtures']) await cp(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  return dir;
}
const readGames = async (site) => JSON.parse(await readFile(path.join(site, 'content', 'games.json'), 'utf8'));
const writeGames = (site, games) => writeFile(path.join(site, 'content', 'games.json'), JSON.stringify(games, null, 2));
const leftovers = async (dir) => (await readdir(dir)).filter((f) => /^\.?(dist|preview)/.test(f));

// Every file, folder and symlink under dir, with contents, to prove a folder was left untouched.
async function snapshot(dir) {
  const seen = {};
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isSymbolicLink()) seen[rel] = `-> ${await readlink(full)}`;
      else if (e.isDirectory()) { seen[`${rel}/`] = ''; await walk(full); }
      else seen[rel] = createHash('sha256').update(await readFile(full)).digest('hex');
    }
  };
  await walk(dir);
  return seen;
}
// Looks like a site output (it has an index.html) but is somebody's project.
async function fakeProject(parent, name = 'project') {
  const dir = path.join(parent, name);
  await mkdir(path.join(dir, '.git'), { recursive: true });
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(dir, 'src', 'app.js'), 'console.log("mine");\n');
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>mine</title>\n');
  return dir;
}
const PASSING = ENV;
const FAILING = { ...ENV, OUTPOST_URL: 'https://sonarr.example.com' };

before(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'hb-site-'));
  out = path.join(await fresh('main'), 'dist');
  const res = build(ENV, out);
  assert.equal(res.status, 0, res.stderr);
  html = await readFile(path.join(out, 'index.html'), 'utf8');
  const js = (await readdir(path.join(out, 'assets'))).find((f) => /^status\.[0-9a-f]{10}\.js$/.test(f));
  script = await readFile(path.join(out, 'assets', js), 'utf8');
});
after(() => rm(work, { recursive: true, force: true }));

const fixture = async (name) => {
  const data = JSON.parse(await readFile(path.join(ROOT, 'fixtures', `status.${name}.json`), 'utf8'));
  data.updated = new Date(Date.now() - 3 * 60000).toISOString();
  return data;
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Loads the page, optionally with a fetch result and a clipboard, and runs status.js.
async function page({ status, fetchError = false, httpStatus = 200, clipboard = null, runJs = true } = {}) {
  const dom = new JSDOM(html, { url: 'https://homebknet.us/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async () => {
    if (fetchError) throw new Error('network down');
    return { ok: httpStatus >= 200 && httpStatus < 300, status: httpStatus, json: async () => status };
  };
  Object.defineProperty(w, 'isSecureContext', { value: true, configurable: true });
  if (clipboard) Object.defineProperty(w.navigator, 'clipboard', { value: clipboard, configurable: true });
  if (runJs) { w.eval(script); await tick(); }
  const d = w.document;
  const q = (s) => d.querySelector(s);
  const chipOf = (sel) => { const c = q(sel); return { state: c.getAttribute('data-state'), word: c.querySelector('.chip-word').textContent, icon: c.querySelector('use').getAttribute('href') }; };
  return { dom, w, d, q, chipOf, close: () => w.close() };
}

test('without JavaScript the page is complete and honest', async () => {
  const p = await page({ runJs: false });
  const chips = [...p.d.querySelectorAll('[data-chip]')];
  assert.ok(chips.length >= 6);
  for (const c of chips) {
    assert.equal(c.getAttribute('data-state'), 'na');
    assert.match(c.textContent, /Status unavailable/);
  }
  for (const b of p.d.querySelectorAll('[data-copy]')) assert.equal(b.hidden, true, 'copy buttons need JS');
  assert.equal(p.q('#notice').hidden, true);
  assert.equal(p.q('#now-na').hidden, false);
  assert.ok(html.includes('https://watch.homebknet.us'));
  assert.ok(html.includes('game.homebknet.us:25565'));
  assert.ok(html.includes('game.homebknet.us:16261'));
  assert.ok(html.includes(`Ask ${OWNER}.`));
  assert.ok(!/\{\{|<!-- @/.test(html), 'no placeholders left');
  assert.ok(!html.includes('style='), 'no inline styles, the CSP forbids them');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'no inline scripts');
  p.close();
});

test('optional slots are left out when their URL is unset', () => {
  assert.ok(!html.includes('Outpost Tech'));
  assert.ok(!html.includes('About me'));
});

test('normal night', async () => {
  const p = await page({ status: await fixture('normal') });
  assert.deepEqual(p.chipOf('.now-row[data-svc="watch"] [data-chip]'), { state: 'online', word: 'Online', icon: '#i-ok' });
  assert.equal(p.chipOf('[data-svc-chip="watch"]').word, 'Watch: Online');
  assert.equal(p.q('.now-row[data-svc="watch"] [data-detail]').textContent, 'Movies and shows');
  const mc = p.q('article[data-game="mc-hardcore"]');
  assert.equal(mc.querySelector('[data-chip]').getAttribute('data-state'), 'online');
  assert.equal(mc.querySelector('[data-well-text]').textContent, '2 of 20 playing');
  assert.equal(mc.querySelector('[data-meter]').hidden, false);
  assert.equal(mc.querySelector('[data-meter-fill]').style.width, '10%');
  const pz = p.q('article[data-game="zomboid"]');
  assert.deepEqual(p.chipOf('article[data-game="zomboid"] [data-chip]'), { state: 'asleep', word: 'Asleep', icon: '#i-sleep' });
  assert.equal(pz.querySelector('[data-well-text]').textContent, `Asleep. Ask ${OWNER} to start it.`);
  assert.equal(p.q('.now-row[data-game="zomboid"] [data-detail]').textContent, `Ask ${OWNER} to start it`);
  assert.equal(p.q('#now-updated').textContent, 'Updated 3 min ago');
  assert.equal(p.q('#now-na').hidden, true);
  assert.equal(p.q('#watch-alert').hidden, true);
  assert.equal(p.q('#hero-down').hidden, true);
  assert.equal(p.q('#now').getAttribute('data-watch'), 'online');
  p.close();
});

test('bad night: Watch offline, games unknown', async () => {
  const p = await page({ status: await fixture('badnight') });
  assert.deepEqual(p.chipOf('.now-row[data-svc="watch"] [data-chip]'), { state: 'offline', word: 'Offline', icon: '#i-fail' });
  assert.equal(p.q('#watch-alert').hidden, false);
  assert.equal(p.q('#hero-down').hidden, false);
  assert.match(p.q('#watch-alert').textContent, new RegExp(`text ${OWNER}`));
  for (const id of ['mc-hardcore', 'zomboid']) {
    assert.equal(p.chipOf(`article[data-game="${id}"] [data-chip]`).state, 'unknown');
    assert.equal(p.q(`.now-row[data-game="${id}"] [data-detail]`).textContent, 'Can’t check right now');
  }
  p.close();
});

test('status unavailable when the fetch fails', async () => {
  const p = await page({ fetchError: true });
  for (const c of p.d.querySelectorAll('[data-chip]')) assert.equal(c.getAttribute('data-state'), 'na');
  assert.equal(p.q('#now-updated').textContent, 'Live status couldn’t load');
  assert.equal(p.q('#now-na').hidden, false);
  p.close();
});

test('status unavailable on an HTTP error', async () => {
  const p = await page({ status: {}, httpStatus: 503 });
  assert.equal(p.chipOf('[data-svc-chip="watch"]').state, 'na');
  p.close();
});

test('maintenance banner shows, then dismisses', async () => {
  const p = await page({ status: await fixture('maintenance') });
  const n = p.q('#notice');
  assert.equal(n.hidden, false);
  assert.equal(n.getAttribute('data-level'), 'info');
  assert.equal(p.q('#notice-text').textContent, 'Planned maintenance tonight, 11 pm to midnight.');
  assert.deepEqual(p.chipOf('article[data-game="mc-hardcore"] [data-chip]'), { state: 'starting', word: 'Starting', icon: '#i-start' });
  p.q('#notice-x').click();
  assert.equal(n.hidden, true);
  p.close();
});

test('warn notice uses the warning icon', async () => {
  const s = await fixture('normal');
  s.notice = { text: 'Streaming is paused while a drive is checked.', level: 'warn' };
  const p = await page({ status: s });
  assert.equal(p.q('#notice').getAttribute('data-level'), 'warn');
  assert.equal(p.q('#notice .notice-ic use').getAttribute('href'), '#i-warn');
  p.close();
});

test('malformed data degrades to unknown, not a crash', async () => {
  const p = await page({ status: { updated: 'not a date', watch: 'nope', games: 'nope', notice: 42 } });
  assert.equal(p.chipOf('[data-svc-chip="watch"]').state, 'unknown');
  assert.equal(p.chipOf('article[data-game="zomboid"] [data-chip]').state, 'unknown');
  assert.equal(p.q('#now-updated').textContent, 'Live status');
  assert.equal(p.q('#notice').hidden, true);
  p.close();
});

test('a game missing from the data shows unknown', async () => {
  const s = await fixture('normal');
  s.games = s.games.filter((g) => g.id !== 'zomboid');
  const p = await page({ status: s });
  assert.equal(p.chipOf('article[data-game="zomboid"] [data-chip]').state, 'unknown');
  assert.equal(p.chipOf('article[data-game="mc-hardcore"] [data-chip]').state, 'online');
  p.close();
});

test('copy button appears with a clipboard and confirms', async () => {
  const written = [];
  const p = await page({ status: await fixture('normal'), clipboard: { writeText: async (t) => { written.push(t); } } });
  const btn = p.q('article[data-game="mc-hardcore"] [data-copy]');
  assert.equal(btn.hidden, false);
  btn.click();
  await tick();
  assert.deepEqual(written, ['game.homebknet.us:25565']);
  assert.equal(btn.getAttribute('data-copied'), 'done');
  assert.equal(p.q('#live').textContent, 'Address copied to your clipboard');
  p.close();
});

test('copy falls back to selecting the address', async () => {
  const p = await page({ status: await fixture('normal'), clipboard: { writeText: async () => { throw new Error('denied'); } } });
  const btn = p.q('.copy-watch [data-copy]');
  btn.click();
  await tick();
  assert.equal(btn.getAttribute('data-copied'), 'selected');
  assert.equal(p.w.getSelection().toString(), 'https://watch.homebknet.us/watch');
  p.close();
});

test('copy buttons stay hidden without a clipboard', async () => {
  const p = await page({ status: await fixture('normal') });
  for (const b of p.d.querySelectorAll('[data-copy]')) assert.equal(b.hidden, true);
  p.close();
});

// ---- build: config, privacy guard, atomic output ------------------------------

test('build refuses to run without the owner name, and writes nothing', async () => {
  const parent = await fresh();
  const res = build({ ...ENV, OWNER_FIRST_NAME: '' }, path.join(parent, 'dist'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /OWNER_FIRST_NAME/);
  assert.deepEqual(await readdir(parent), [], 'no dist/ and no temp folder');
});

test('build refuses to publish anything on the private list, and leaves no output', async () => {
  const parent = await fresh();
  const res = build({ ...ENV, OUTPOST_URL: 'https://sonarr.example.com' }, path.join(parent, 'dist'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /must not appear/);
  assert.deepEqual(await readdir(parent), [], 'no dist/ and no temp folder');
});

test('a failed guard removes the previous dist/ too, so a stale build cannot be deployed', async () => {
  const parent = await fresh();
  const dist = path.join(parent, 'dist');
  assert.equal(build(ENV, dist).status, 0);
  assert.ok(existsSync(path.join(dist, 'index.html')));
  const res = build({ ...ENV, OUTPOST_URL: 'https://sonarr4k.example.com' }, dist);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /must not appear/);
  assert.equal(existsSync(dist), false, 'dist/ is gone');
  assert.deepEqual(await readdir(parent), [], 'no temp or old folders left behind');
});

test('a forbidden word planted in content fails the default build and leaves no dist/', async () => {
  const site = await siteCopy();
  assert.equal(build(ENV, null, { root: site }).status, 0);
  assert.ok(existsSync(path.join(site, 'dist', 'index.html')));
  const games = await readGames(site);
  games[0].rules.extra = 'Requests go in radarr_movies.';
  await writeGames(site, games);
  const res = build(ENV, null, { root: site });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /mentions "radarr"/);
  assert.equal(existsSync(path.join(site, 'dist')), false);
  assert.deepEqual(await leftovers(site), []);
});

test('an unexpected error also leaves no dist/ and no temp folder', async () => {
  const site = await siteCopy();
  assert.equal(build(ENV, null, { root: site }).status, 0);
  await rm(path.join(site, 'src', 'og.png'));
  const res = build(ENV, null, { root: site });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /og\.png/);
  assert.equal(existsSync(path.join(site, 'dist')), false);
  assert.deepEqual(await leftovers(site), []);
});

// Starts a build in `site` that pauses right after writing index.html: og.png is replaced by a named
// pipe, which the build waits on until release() opens and closes it (og.png is then copied empty).
async function pausedBuild(site, env, outDir = path.join(site, 'dist')) {
  const fifo = path.join(site, 'src', 'og.png');
  await rm(fifo);
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo');
  const child = spawn(process.execPath, [path.join(site, 'build.mjs')], {
    cwd: site, env: { ...env, OUT_DIR: outDir }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
  let tmpDir = null;
  for (let i = 0; i < 200 && !tmpDir; i++) {
    const parent = path.dirname(outDir);
    const t = (await readdir(parent)).find((f) => f.startsWith(`.${path.basename(outDir)}-build-`));
    if (t && existsSync(path.join(parent, t, 'index.html'))) tmpDir = path.join(parent, t);
    else await new Promise((r) => setTimeout(r, 25));
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000); // never leave a stuck build behind
  const done = async () => { const r = await exited; clearTimeout(timer); return r; };
  // Non-blocking open: it only succeeds once the build is waiting on the pipe, so the test never hangs.
  const release = async () => {
    for (let i = 0; i < 200; i++) {
      try { await (await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)).close(); return; } catch (e) {
        if (e.code !== 'ENXIO') throw e;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    throw new Error('the build never opened og.png');
  };
  return { child, tmpDir, done, release };
}

test('the new build never touches dist/ until it is done, and SIGTERM cleans up', { timeout: 20000 }, async () => {
  const site = await siteCopy();
  assert.equal(build(ENV, null, { root: site }).status, 0);
  const dist = path.join(site, 'dist');
  const before = await readFile(path.join(dist, 'index.html'), 'utf8');
  const run = await pausedBuild(site, { ...ENV, PORTFOLIO_URL: 'https://example.com/new-build' });
  try {
    assert.ok(run.tmpDir, 'the build writes into a hidden temp folder');
    assert.ok((await readFile(path.join(run.tmpDir, 'index.html'), 'utf8')).includes('new-build'));
    assert.equal(await readFile(path.join(dist, 'index.html'), 'utf8'), before, 'dist/ still holds the previous build');
  } finally {
    run.child.kill('SIGTERM');
  }
  const result = await run.done();
  assert.deepEqual([result.code, result.signal], [null, 'SIGTERM'], 'exits promptly on SIGTERM');
  assert.equal(existsSync(dist), false, 'an interrupted build leaves no dist/');
  assert.deepEqual(await leftovers(site), []);
});

test('dist/ swapped for something else during the build is left alone, on success and on failure', { timeout: 30000 }, async () => {
  for (const env of [PASSING, FAILING]) {
    const site = await siteCopy();
    assert.equal(build(ENV, null, { root: site }).status, 0);
    const dist = path.join(site, 'dist');
    const run = await pausedBuild(site, env);
    try {
      assert.ok(run.tmpDir, 'build paused');
      // The checks passed at the start; now dist/ becomes somebody's folder.
      await rm(dist, { recursive: true });
      await fakeProject(site, 'dist');
      const before = await snapshot(dist);
      await run.release();
      const result = await run.done();
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, env === PASSING ? /left alone/ : /must not appear/);
      assert.deepEqual(await snapshot(dist), before, 'the swapped-in folder is untouched');
      assert.deepEqual(await leftovers(site), ['dist']);
    } finally {
      run.child.kill('SIGKILL');
    }
  }
});

test('an empty OUT_DIR filled during the build is left alone, on success and on failure', { timeout: 30000 }, async () => {
  for (const env of [PASSING, FAILING]) {
    const site = await siteCopy();
    const dir = path.join(site, 'out');
    await mkdir(dir);
    const run = await pausedBuild(site, env, dir);
    try {
      assert.ok(run.tmpDir, 'build paused');
      await writeFile(path.join(dir, 'notes.txt'), 'written while the build ran');
      await run.release();
      const result = await run.done();
      assert.equal(result.code, 1, result.stderr);
      assert.deepEqual(await readdir(dir), ['notes.txt']);
      assert.deepEqual((await readdir(site)).filter((f) => f.startsWith('.out-')), [], 'no temp folder left');
    } finally {
      run.child.kill('SIGKILL');
    }
  }
});

test('an OUT_DIR that is not an earlier build is refused and left alone', async () => {
  const dir = await fresh();
  await writeFile(path.join(dir, 'keep.txt'), 'not a build');
  const res = build(ENV, dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not a build from this repo/);
  assert.deepEqual(await readdir(dir), ['keep.txt']);
});

// ---- build: only folders it made itself are ever removed or replaced ----------------

test('every build carries a marker that does not publish a plain hash of the repo path', async () => {
  const text = await readFile(path.join(out, '.homebknet-build'), 'utf8');
  assert.match(text, /^homebknet-site build output v1\nrepo [0-9a-f]{64}\n$/);
  const real = realpathSync(ROOT);
  assert.ok(!text.includes(real), 'no path in the marker');
  assert.ok(!text.includes(createHash('sha256').update(real).digest('hex')), 'the hash is keyed');
});

test('a project folder with an index.html is refused and untouched, on success and on failure', async () => {
  const parent = await fresh();
  const project = await fakeProject(parent);
  const before = await snapshot(project);
  for (const [label, env] of [['passing', PASSING], ['failing', FAILING]]) {
    const res = build(env, project);
    assert.equal(res.status, 1, `${label} build was allowed into the project`);
    assert.match(res.stderr, /not a build from this repo/);
    assert.deepEqual(await snapshot(project), before, `${label} build changed the project`);
    assert.deepEqual(await readdir(parent), ['project'], 'no temp folder left next to it');
  }
});

test('a marker from another copy of the repo is refused, even with the same key', async () => {
  const a = await siteCopy();
  assert.equal(build(ENV, null, { root: a }).status, 0);
  const aDist = path.join(a, 'dist');
  const before = await snapshot(aDist);
  // This repo has its own key and path.
  let res = build(PASSING, aDist);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not a build from this repo/);
  // A full copy (same .cache/build-key) at another path is still another repo.
  const b = path.join(work, `site-copy-${++serial}`);
  await cp(a, b, { recursive: true });
  for (const env of [PASSING, FAILING]) {
    res = build(env, aDist, { root: b });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not a build from this repo/);
  }
  res = build(PASSING, null, { root: b });
  assert.equal(res.status, 1, "the copied dist/ carries a's marker");
  assert.match(res.stderr, /not a build from this repo/);
  assert.deepEqual(await snapshot(aDist), before);
});

test('a tampered marker is refused and the folder is untouched', async () => {
  const parent = await fresh();
  const dist = path.join(parent, 'dist');
  assert.equal(build(PASSING, dist).status, 0);
  await appendFile(path.join(dist, '.homebknet-build'), ' ');
  const before = await snapshot(dist);
  for (const env of [PASSING, FAILING]) {
    const res = build(env, dist);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not a build from this repo/);
    assert.deepEqual(await snapshot(dist), before);
  }
});

test('a symlink is refused, and neither the link nor its target is touched', async () => {
  const parent = await fresh();
  const real = path.join(parent, 'real');
  assert.equal(build(PASSING, real).status, 0); // a genuine earlier build behind the link
  const project = await fakeProject(parent);
  for (const target of [real, project]) {
    const link = path.join(parent, `link-to-${path.basename(target)}`);
    await symlink(target, link);
    const before = await snapshot(target);
    for (const env of [PASSING, FAILING]) {
      const res = build(env, link);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /is a symlink/);
      assert.ok(lstatSync(link).isSymbolicLink(), 'the link is still there');
      assert.equal(await readlink(link), target);
      assert.deepEqual(await snapshot(target), before);
    }
  }
  // The default dist/ as a symlink into somebody's project.
  const site = await siteCopy();
  const victim = await fakeProject(site, 'elsewhere');
  await symlink(victim, path.join(site, 'dist'));
  const before = await snapshot(victim);
  const res = build(PASSING, null, { root: site });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /is a symlink/);
  assert.deepEqual(await snapshot(victim), before);
  assert.deepEqual(await leftovers(site), ['dist']);
});

test('an empty OUT_DIR is used on success and removed on failure', async () => {
  const parent = await fresh();
  const dir = path.join(parent, 'empty');
  await mkdir(dir);
  assert.equal(build(PASSING, dir).status, 0);
  assert.ok(existsSync(path.join(dir, 'index.html')));
  assert.ok(existsSync(path.join(dir, '.homebknet-build')));
  await rm(dir, { recursive: true });
  await mkdir(dir);
  const res = build(FAILING, dir);
  assert.equal(res.status, 1);
  assert.deepEqual(await readdir(parent), [], 'a failed build leaves no output folder at all');
});

const BYPASSES = [
  ['a word with a digit after it', 'https://sonarr4k.example.com', /mentions "sonarr"/],
  ['a word with an underscore after it', 'https://example.com/radarr_movies', /mentions "radarr"/],
  ['a word with an underscore before it', 'https://example.com/my_prowlarr', /mentions "prowlarr"/],
  ['a capitalised word', 'https://example.com/Jellyseerr', /mentions "Jellyseerr"/],
  ['an IPv4 literal with a port', 'https://1.2.3.4:8096', /exposes port 8096/],
  ['a single-label host with a port', 'https://box:8096', /exposes port 8096/],
  ['a host name with a port', 'https://media.example.com:8096', /exposes port 8096/],
  ['an [IPv6] host with a port', 'https://[2001:db8::1]:8920', /exposes port 8920/],
  ['a MagicDNS tailnet name', 'https://tail1a2b3c.example.com', /mentions "tail1a2b3c"/],
  ['a ts.net host', 'https://box.example.ts.net', /mentions "ts\.net"/],
  ['the Tailscale IPv6 range', 'https://[fd7a:115c:a1e0::53]/', /mentions "fd7a:115c:a1e0"/],
  ['a Tailscale IPv4 address', 'https://100.101.102.103/', /private address \(100\.101\.102\.103\)/],
  ['a LAN IPv4 address', 'https://192.168.1.10/', /private address \(192\.168\.1\.10\)/],
  ['a .local host name', 'https://nas.local/', /mentions "nas\.local"/],
];
for (const [label, url, expected] of BYPASSES) {
  test(`guard catches ${label}`, async () => {
    const parent = await fresh();
    const res = build({ ...ENV, PORTFOLIO_URL: url }, path.join(parent, 'dist'));
    assert.equal(res.status, 1, `${url} was published`);
    assert.match(res.stderr, expected);
    assert.deepEqual(await readdir(parent), []);
  });
}

test('guard catches bare host:port, IPv4:port and name:port in page text', async () => {
  const site = await siteCopy();
  const games = await readGames(site);
  for (const [text, port] of [['Mirror at media.example.com:8096', '8096'], ['Or 203.0.113.9:7878', '7878'],
    ['Admin on mediaserver:8096', '8096'], ['Try box-2:8920.', '8920']]) {
    games[0].rules.extra = text;
    await writeGames(site, games);
    const res = build(ENV, null, { root: site });
    assert.equal(res.status, 1, text);
    assert.match(res.stderr, new RegExp(`exposes port ${port}`));
    assert.equal(existsSync(path.join(site, 'dist')), false);
  }
});

test('guard refuses every admin app on the private list', async () => {
  const names = ['portainer', 'unraid', 'proxmox', 'pihole', 'pi-hole', 'adguard', 'homeassistant', 'home-assistant',
    'vaultwarden', 'jfa-go', 'nzbhydra2', 'tautulli', 'ombi', 'requestrr', 'cockpit', 'webmin', 'Grafana',
    'sabnzbd', 'dashboard', 'uptime-kuma', 'ntfy', 'wol-relay', 'localhost'];
  const parent = await fresh();
  for (const name of names) {
    const res = build({ ...ENV, PORTFOLIO_URL: `https://example.com/${name}` }, path.join(parent, 'dist'));
    assert.equal(res.status, 1, `${name} was published`);
    assert.match(res.stderr, /must not appear/, name);
  }
  assert.deepEqual(await readdir(parent), []);
});

test('guard does not trip on ordinary words or the game ports', async () => {
  const parent = await fresh();
  const url = 'https://game.homebknet.us:25565/zombie-combination-tailored-details-localStorage-dashed-Tailscale';
  const res = build({ ...ENV, PORTFOLIO_URL: url }, path.join(parent, 'dist'));
  assert.equal(res.status, 0, res.stderr);
});

test('guard lets times, ratios and timestamps through', async () => {
  const site = await siteCopy();
  const games = await readGames(site);
  games[0].rules.extra = 'Open 10:30 to 22:41:00, shown at 16:9, last reset 2026-10-24T22:41:00Z. Ratio 4:3.';
  await writeGames(site, games);
  const res = build(ENV, null, { root: site });
  assert.equal(res.status, 0, res.stderr);
  assert.match(await readFile(path.join(site, 'dist', 'index.html'), 'utf8'), /Open 10:30 to 22:41:00, shown at 16:9/);
});

test('"$" patterns in game names stay literal and do not duplicate the page', async () => {
  const site = await siteCopy();
  const games = await readGames(site);
  const name = "Cash $` and $& and $' and $$ and $1";
  games[0].name = name;
  games[1].rules = { title: '$`', text: '$&', extra: "$'" };
  await writeGames(site, games);
  const res = build(ENV, null, { root: site });
  assert.equal(res.status, 0, res.stderr);
  const page = await readFile(path.join(site, 'dist', 'index.html'), 'utf8');
  assert.equal(page.match(/<!doctype html>/gi).length, 1, 'page head not duplicated');
  assert.equal(page.match(/<\/html>/g).length, 1, 'page tail not duplicated');
  assert.equal(page.match(/<main>/g).length, 1);
  const d = new JSDOM(page).window.document;
  assert.equal(d.querySelector('.now-row[data-game="mc-hardcore"] .now-name').textContent, name);
  assert.equal(d.querySelector('#game-mc-hardcore-title').textContent, name);
  const zomboid = d.querySelector('article[data-game="zomboid"]');
  assert.equal(zomboid.querySelector('.rule-title').textContent, '$`');
  assert.equal(zomboid.querySelector('.rule-text').textContent, '$&');
  assert.equal(zomboid.querySelector('.rule-extra').textContent, "$'");
});

test('a normal build has no status.json', () => {
  assert.equal(existsSync(path.join(out, 'status.json')), false);
});

test('a sample build writes preview/ and never dist/', async () => {
  const site = await siteCopy();
  const res = build(ENV, null, { root: site, args: ['--sample-status=normal'] });
  assert.equal(res.status, 0, res.stderr);
  const status = JSON.parse(await readFile(path.join(site, 'preview', 'status.json'), 'utf8'));
  assert.equal(status.watch.state, 'online');
  assert.ok(existsSync(path.join(site, 'preview', 'index.html')));
  assert.equal(existsSync(path.join(site, 'dist')), false, 'no dist/ at all');

  const forced = build({ ...ENV, OUT_DIR: 'dist' }, null, { root: site, args: ['--sample-status=badnight'] });
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /never writes to dist/);
  assert.equal(existsSync(path.join(site, 'dist', 'status.json')), false);
  assert.equal(existsSync(path.join(site, 'dist')), false);

  const traversal = build(ENV, null, { root: site, args: ['--sample-status=../content/games'] });
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /must name a fixture/);
  assert.equal(existsSync(path.join(site, 'preview')), false, 'a failed sample build removes preview/');
  assert.deepEqual(await leftovers(site), []);
});
