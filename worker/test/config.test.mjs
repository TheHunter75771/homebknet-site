// One source of truth for the game list, a sane wrangler.toml, and nothing private in this folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES, PROBE_TYPES, parseAddress } from '../src/games.js';

import { WORKER, SITE } from './helpers/site.mjs';
import { overrideProblem } from './helpers/semver-min.mjs';

const SITE_GAMES = path.join(SITE, 'content', 'games.json');

test('the game list mirrors site/content/games.json (id, name, address, order)', () => {
  const site = JSON.parse(readFileSync(SITE_GAMES, 'utf8'));
  const pick = ({ id, name, address }) => ({ id, name, address });
  assert.deepEqual(GAMES.map(pick), site.map(pick),
    'site/content/games.json and worker/src/games.js disagree: update worker/src/games.js to match the site');
});

test('every game declares a known probe, and Java servers use the Java ping', () => {
  const site = JSON.parse(readFileSync(SITE_GAMES, 'utf8'));
  for (const g of GAMES) {
    assert.ok(PROBE_TYPES.includes(g.probe), `${g.id}: probe "${g.probe}"`);
    const s = site.find((x) => x.id === g.id);
    if (s && /Minecraft: Java Edition/i.test(s.game || '')) assert.equal(g.probe, 'minecraft-java', g.id);
  }
  assert.equal(GAMES.find((g) => g.id === 'zomboid').probe, 'none', 'Zomboid is UDP; a Worker cannot ask it');
});

test('every probe target is a public homebknet.us hostname, never an IP', () => {
  for (const g of GAMES) {
    const { hostname, port } = parseAddress(g.address);
    assert.ok(hostname.endsWith('.homebknet.us'), `${g.id}: ${hostname}`);
    assert.ok(!/^[\d.]+$/.test(hostname), `${g.id}: IP literal`);
    assert.ok(port >= 1024, `${g.id}: port ${port}`);
  }
});

test('parseAddress accepts host:port and nothing else', () => {
  assert.deepEqual(parseAddress('game.homebknet.us:25565'), { hostname: 'game.homebknet.us', port: 25565 });
  assert.deepEqual(parseAddress('GAME.homebknet.us:1'), { hostname: 'game.homebknet.us', port: 1 });
  for (const bad of ['game.homebknet.us', 'game.homebknet.us:', ':25565', 'game.homebknet.us:0', 'game.homebknet.us:65536',
    'game.homebknet.us:99999', 'a b:1', '[::1]:25565', 'http://game.homebknet.us:1', 'game.homebknet.us:25565/x',
    'game.homebknet.us:25565:1', 'game.homebknet.us:-1', '', null, 25565]) {
    assert.throws(() => parseAddress(bad), RangeError, String(bad));
  }
});

test('wrangler.toml: name, route, vars, and no workers.dev address', () => {
  const toml = readFileSync(path.join(WORKER, 'wrangler.toml'), 'utf8');
  const line = (re) => { const m = toml.match(re); assert.ok(m, String(re)); return m[1]; };
  assert.equal(line(/^name\s*=\s*"([^"]*)"/m), 'homebknet-status');
  assert.equal(line(/^main\s*=\s*"([^"]*)"/m), 'src/index.js');
  const date = line(/^compatibility_date\s*=\s*"([^"]*)"/m);
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Date.parse(date) <= Date.now(), 'compatibility_date is not in the future');
  assert.match(toml, /^routes\s*=\s*\[\s*\{\s*pattern\s*=\s*"homebknet\.us\/status\.json"\s*,\s*zone_name\s*=\s*"homebknet\.us"\s*\}\s*\]\s*$/m);
  assert.equal(line(/^workers_dev\s*=\s*(\w+)/m), 'false');
  assert.equal(line(/^NOTICE_TEXT\s*=\s*"([^"]*)"/m), '');
  assert.equal(line(/^NOTICE_LEVEL\s*=\s*"([^"]*)"/m), 'info');
  assert.equal(line(/^CACHE_SECONDS\s*=\s*"([^"]*)"/m), '30');
});

test('package.json: no runtime dependencies, wrangler pinned exactly and locked', () => {
  const pkg = JSON.parse(readFileSync(path.join(WORKER, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies || {}), ['wrangler']);
  const pin = pkg.devDependencies.wrangler;
  assert.match(pin, /^\d+\.\d+\.\d+$/, 'an exact version, no ^ or ~: wrangler holds the Cloudflare login');
  assert.equal(pkg.scripts.test, 'node --test test/*.test.mjs');
  const lock = JSON.parse(readFileSync(path.join(WORKER, 'package-lock.json'), 'utf8'));
  assert.ok(lock.lockfileVersion >= 2);
  assert.equal(lock.packages[''].devDependencies.wrangler, pin);
  assert.equal(lock.packages['node_modules/wrangler'].version, pin);
  assert.equal(lock.packages[''].dependencies, undefined);
});

test('the undici override is exact, patched, and what the lockfile installs', () => {
  const pkg = JSON.parse(readFileSync(path.join(WORKER, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(WORKER, 'package-lock.json'), 'utf8'));
  const want = pkg.overrides && pkg.overrides.undici;
  assert.match(String(want), /^\d+\.\d+\.\d+$/, 'overrides.undici is an exact version');
  const [maj, min, pat] = want.split('.').map(Number);
  assert.ok(maj > 7 || (maj === 7 && (min > 30 || (min === 30 && pat >= 1))), `undici ${want} is at least 7.30.1, the patched release`);
  for (const [key, meta] of Object.entries(lock.packages)) {
    if (key === 'node_modules/undici' || key.endsWith('/node_modules/undici')) assert.equal(meta.version, want, key);
  }
  // A wrangler bump (say, from Dependabot) may ship a newer undici than the override, as an exact
  // pin or a range; the override must never sit below the lowest version that spec allows. When this
  // fails, raise the override or drop it.
  let checked = 0;
  for (const [key, meta] of Object.entries(lock.packages)) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const declared = meta[field] && meta[field].undici;
      if (declared === undefined) continue;
      checked++;
      const problem = overrideProblem(want, declared);
      assert.equal(problem, null, `${key} ${field}: ${problem}`);
    }
  }
  assert.ok(checked > 0, 'something in the lockfile still declares undici (else drop the override)');
});

test('compatibility_date is no newer than what the locked workerd supports', () => {
  const toml = readFileSync(path.join(WORKER, 'wrangler.toml'), 'utf8');
  const date = toml.match(/^compatibility_date\s*=\s*"([^"]*)"/m)[1];
  const lock = JSON.parse(readFileSync(path.join(WORKER, 'package-lock.json'), 'utf8'));
  const workerd = lock.packages['node_modules/workerd'].version; // 1.YYYYMMDD.n
  const m = /^1\.(\d{4})(\d{2})(\d{2})\./.exec(workerd);
  assert.ok(m, `workerd version ${workerd}`);
  assert.ok(date <= `${m[1]}-${m[2]}-${m[3]}`, `compatibility_date ${date} is newer than workerd ${workerd}; wrangler dev would refuse to start`);
});

// ---- privacy ----------------------------------------------------------------------

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.wrangler') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

const ALLOWED_HOSTS = new Set([
  'homebknet.us', 'watch.homebknet.us', 'game.homebknet.us', // the public names
  'developers.cloudflare.com', 'minecraft.wiki', 'workers.dev', // Cloudflare and protocol docs
  'evil.example', 'elsewhere.example', 'example.com', // test fixtures (reserved names)
]);
const ALLOWED_IPS = new Set(['127.0.0.1', '169.254.169.254']); // generic SSRF probes in the tests
const HOST_RE = /\b(?:[a-z0-9-]+\.)+(?:us|net|com|org|io|dev|app|wiki|me|co|xyz|cloud|example|internal|local|lan|home|arpa)\b(?!\.[a-z0-9])/gi;
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Generic only: admin apps and private-network names that must never be public. Personal terms
// (names, hostnames, anything about the owner) go in the git-ignored local list below instead.
const PRIVATE_WORDS = /\b(sonarr|radarr|prowlarr|lidarr|readarr|bazarr|sabnzbd|nzbget|jellyseerr|overseerr|qbittorrent|tailnet|ts\.net)\b/i;
const PRIVATE_IP = /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/;

test('nothing identifying: only the public hostnames, no IPs, no emails, no private names', () => {
  const self = fileURLToPath(import.meta.url);
  for (const file of files(WORKER)) {
    if (!/\.(m?js|json|toml|md)$/.test(file) || file === self) continue;
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(WORKER, file);
    // package-lock.json is generated third-party metadata (registry URLs); the authored files get
    // the allowlist, and every file gets the private-word and private-address checks.
    if (rel !== 'package-lock.json') {
      for (const m of text.matchAll(HOST_RE)) assert.ok(ALLOWED_HOSTS.has(m[0].toLowerCase()), `${rel}: hostname ${m[0]}`);
      for (const m of text.matchAll(IP_RE)) assert.ok(ALLOWED_IPS.has(m[0]), `${rel}: IP ${m[0]}`);
      for (const m of text.matchAll(EMAIL_RE)) assert.ok(m[0].endsWith('@example.com'), `${rel}: email ${m[0]}`);
    }
    const word = text.match(PRIVATE_WORDS);
    assert.equal(word, null, `${rel}: mentions "${word && word[0]}"`);
    const ip = text.match(PRIVATE_IP);
    assert.equal(ip, null, `${rel}: private address ${ip && ip[0]}`);
  }
});

// Invisible and bidi control characters in source are a review hazard ("Trojan Source").
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;

test('no invisible or bidi control characters in any file, and src/ is plain ASCII', () => {
  for (const file of files(WORKER)) {
    if (!/\.(m?js|json|toml|md)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(WORKER, file);
    const m = text.match(INVISIBLE);
    assert.equal(m, null, `${rel}: U+${m && m[0].codePointAt(0).toString(16).padStart(4, '0')}`);
    if (rel.startsWith('src' + path.sep)) assert.ok(/^[\x00-\x7f]*$/.test(text), `${rel}: non-ASCII character`);
  }
});

// Optional: personal words to keep out of this folder, one per line ('#' starts a comment).
// The file is git-ignored and never committed, so the words themselves stay private.
const LOCAL_WORDS = path.join(WORKER, 'test', 'private-words.local.txt');
const localWords = existsSync(LOCAL_WORDS)
  ? readFileSync(LOCAL_WORDS, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean)
  : null;

test('none of the local private words appear in any file', { skip: localWords ? false : 'no test/private-words.local.txt' }, () => {
  for (const file of files(WORKER)) {
    if (file === LOCAL_WORDS || !/\.(m?js|json|toml|md|txt)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8').toLowerCase();
    const rel = path.relative(WORKER, file);
    for (const w of localWords) assert.ok(!text.includes(w), `${rel}: contains a word from the local private list (line ${localWords.indexOf(w) + 1})`);
  }
});

test('the local private-words file is git-ignored', () => {
  const ignore = readFileSync(path.join(WORKER, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('test/private-words.local.txt'));
});
