#!/usr/bin/env node
// Builds dist/ from src/ for Cloudflare Pages. No dependencies; Node 20 or newer.
//
//   OWNER_FIRST_NAME=… CONTACT_EMAIL=… node build.mjs
//   node build.mjs --sample-status=normal   (writes preview/ with a sample status.json, never dist/)
//
// Env: OWNER_FIRST_NAME, CONTACT_EMAIL (required); SITE_URL (default https://homebknet.us);
//      OUTPOST_URL, PORTFOLIO_URL (optional, the slot is left out when unset);
//      OUT_DIR (optional, default dist/, or preview/ with --sample-status).
//
// The page is built in a hidden temp folder next to the output folder. Only when every check and the
// privacy guard pass is it renamed into place. On any failure the temp folder is removed and so is
// the previous output folder, so a stale build can never be mistaken for the new one.
//
// The build only ever removes or replaces a folder that it made itself: one carrying a valid
// .homebknet-build marker for this repo, or an empty one. Anything else (a symlink, a file, a folder
// with other content, a marker from another copy of the repo) is refused and left untouched.

import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const BUDGET_BYTES = 100 * 1024; // brief: under 100 KB before images

// Exits 1. Once the exit handler below is registered, that also cleans up (see "From here on").
const fail = (msg) => { console.error(`build: ${msg}`); process.exit(1); };
const env = (key, fallback = '') => (process.env[key] ?? fallback).trim();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- output folder ------------------------------------------------------------
const sampleArg = process.argv.find((a) => a === '--sample-status' || a.startsWith('--sample-status='));
const sample = sampleArg ? (sampleArg.split('=')[1] || 'normal') : null;
const OUT = path.resolve(ROOT, process.env.OUT_DIR || (sample ? 'preview' : 'dist'));
const inside = (dir, parent) => dir === parent || dir.startsWith(parent + path.sep);
const shown = (p) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; };
const lstat = (p) => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// The marker ties an output folder to this copy of the repo: a fixed signature plus a hash of the
// repo's real path. The hash is keyed with a random secret kept in the git-ignored .cache/, because the
// marker is published with the site and a plain hash of a local path could be confirmed by guessing.
const MARKER = '.homebknet-build';
const SIGNATURE = 'homebknet-site build output v1';
function buildKey() {
  const file = path.join(ROOT, '.cache', 'build-key');
  try { return readFileSync(file, 'utf8').trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (e) { if (e.code !== 'EEXIST') throw e; } // another build made it first
  return readFileSync(file, 'utf8').trim();
}
const MARKER_TEXT = `${SIGNATURE}\nrepo ${createHmac('sha256', buildKey()).update(realpathSync(ROOT)).digest('hex')}\n`;
// True only for a real folder (not a symlink) whose marker is a regular file with exactly our text.
function isOurBuild(dir) {
  const d = lstat(dir);
  if (!d || !d.isDirectory()) return false;
  const m = lstat(path.join(dir, MARKER));
  return Boolean(m && m.isFile() && m.size === Buffer.byteLength(MARKER_TEXT) && readFileSync(path.join(dir, MARKER), 'utf8') === MARKER_TEXT);
}

// These checks run before the exit handler exists, so a refused OUT_DIR is left alone.
if (sample && (inside(OUT, path.join(ROOT, 'dist')) || path.basename(OUT) === 'dist')) {
  fail('--sample-status builds a local preview and never writes to dist/. Leave OUT_DIR unset (preview/).');
}
if (OUT === path.parse(OUT).root || inside(ROOT, OUT) ||
    ['src', 'content', 'fixtures', 'tools', 'worker', '.git', '.github', '.cache'].some((d) => inside(OUT, path.join(ROOT, d)))) {
  fail(`refusing to build into ${OUT}.`);
}
// What is at OUT now decides what the build may do with it later: 'none', 'empty' or 'ours'.
let prior = 'none';
const outStat = lstat(OUT);
if (outStat) {
  if (outStat.isSymbolicLink()) fail(`${OUT} is a symlink. The build only replaces a real folder it made itself.`);
  if (!outStat.isDirectory()) fail(`${OUT} exists and is not a folder.`);
  if (readdirSync(OUT).length === 0) prior = 'empty';
  else if (isOurBuild(OUT)) prior = 'ours';
  else fail(`${OUT} is not a build from this repo (no valid ${MARKER} marker), so it was left alone. Remove it yourself if it is safe to.`);
  if (!process.env.OUT_DIR && !inside(realpathSync(OUT), realpathSync(ROOT))) fail(`${OUT} is not inside the repo.`);
}

// From here on, any exit that is not a finished build removes the temp folder and the old output.
let tmp = null;
let committed = false;
const trash = [];
// Takes the previous output out of the way, but only if it is still exactly what the checks above
// accepted. Renaming is atomic, so the folder disappears in one step even if removal is interrupted.
function removeOld() {
  if (prior === 'ours' && isOurBuild(OUT)) {
    const to = path.join(path.dirname(OUT), `.${path.basename(OUT)}-old-${process.pid}-${randomBytes(4).toString('hex')}`);
    renameSync(OUT, to);
    trash.push(to);
  } else if (prior === 'empty' && lstat(OUT)?.isDirectory()) {
    rmdirSync(OUT); // throws if something was put in it meanwhile, which then stays
  }
}
const cleanup = () => {
  if (!committed) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    try { removeOld(); } catch (e) { console.error(`build: left ${OUT} in place (${e.code || e.message}).`); }
  }
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
};
process.on('exit', cleanup); // fail(), uncaught errors and normal ends
// On a signal: clean up, then re-raise it with the default action. process.exit() could hang here
// if a file operation is stuck, because Node waits for its I/O threads before exiting.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.removeAllListeners(sig); process.kill(process.pid, sig); });
}

// ---- config -----------------------------------------------------------------
const cfg = {
  owner_first_name: env('OWNER_FIRST_NAME'),
  contact_email: env('CONTACT_EMAIL'),
  site_url: env('SITE_URL', 'https://homebknet.us').replace(/\/+$/, ''),
  outpost_url: env('OUTPOST_URL'),
  portfolio_url: env('PORTFOLIO_URL'),
};
if (!cfg.owner_first_name) fail('OWNER_FIRST_NAME is not set.');
if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(cfg.contact_email)) fail('CONTACT_EMAIL is missing or is not an email address.');
for (const key of ['site_url', 'outpost_url', 'portfolio_url']) {
  if (cfg[key] && !/^https:\/\/[^\s"'<>]+$/.test(cfg[key])) fail(`${key.toUpperCase()} must be an https:// URL.`);
}
if (sample && !/^[a-z0-9-]+$/.test(sample)) fail(`--sample-status must name a fixture, e.g. --sample-status=normal.`);

// ---- games ------------------------------------------------------------------
const games = JSON.parse(await readFile(path.join(ROOT, 'content', 'games.json'), 'utf8'));
if (!Array.isArray(games) || games.length === 0) fail('content/games.json must be a non-empty array.');
const ids = new Set();
for (const g of games) {
  if (!/^[a-z0-9-]+$/.test(g.id || '')) fail(`game id "${g.id}" must be lowercase letters, digits and dashes.`);
  if (ids.has(g.id)) fail(`duplicate game id "${g.id}".`);
  ids.add(g.id);
  for (const k of ['name', 'address']) if (!g[k]) fail(`game "${g.id}" is missing "${k}".`);
}

const chip = (prefix = '') =>
  `<span class="chip" data-chip${prefix ? ` data-prefix="${esc(prefix)}"` : ''} data-state="na">` +
  `<svg class="ic chip-ic" aria-hidden="true"><use href="#i-na"/></svg>` +
  `<span class="chip-word">${esc(prefix)}Status unavailable</span></span>`;

const nowRow = (g) => `<li class="now-row" data-game="${g.id}">
<div class="now-text"><p class="now-name">${esc(g.name)}</p><p class="now-detail" data-detail hidden></p></div>
${chip()}
</li>`;

function gameCard(g) {
  const titleId = `game-${g.id}-title`;
  const sub = g.game && g.game !== g.name ? `\n<p class="game-sub">${esc(g.game)}</p>` : '';
  const r = g.rules;
  const rule = r && r.title ? `
<div class="rule${r.tone === 'warn' ? ' rule-warn' : ''}">
<svg class="ic ic-22 rule-ic" aria-hidden="true"><use href="#${r.tone === 'warn' ? 'i-heart' : 'i-info'}"/></svg>
<div>
<p class="rule-title">${esc(r.title)}</p>${r.text ? `\n<p class="rule-text">${esc(r.text)}</p>` : ''}${r.extra ? `\n<p class="rule-extra">${esc(r.extra)}</p>` : ''}
</div>
</div>` : '';
  const facts = [['Version', g.version], ['Mods', g.mods]].filter(([, v]) => v);
  const dl = facts.length ? `
<dl class="facts">
${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('\n')}
</dl>` : '';
  return `<article class="card game" data-game="${g.id}" aria-labelledby="${titleId}">
<div class="game-head">
<div class="game-id">
<span class="tile-ic" aria-hidden="true"><svg class="ic"><use href="#i-pad"/></svg></span>
<div>
<h3 id="${titleId}" class="game-name">${esc(g.name)}</h3>${sub}
</div>
</div>
${chip()}
</div>
<div class="well" data-well data-state="na">
<p class="well-text" data-well-text>Live status unavailable. You can still try joining.</p>
<div class="meter" data-meter hidden><div class="meter-fill" data-meter-fill></div></div>
</div>${rule}
<div>
<p class="field-label">Server address</p>
<div class="copy">
<code class="copy-value" data-copy-value>${esc(g.address)}</code>
<button type="button" class="copy-btn" data-copy hidden><span class="copy-idle"><svg class="ic ic-18" aria-hidden="true"><use href="#i-copy"/></svg>Copy<span class="sr-only"> ${esc(g.name)} address</span></span><span class="copy-done"><svg class="ic ic-18 ic-bold" aria-hidden="true"><use href="#i-check"/></svg>Copied</span><span class="copy-sel"><svg class="ic ic-18" aria-hidden="true"><use href="#i-select"/></svg>Selected</span></button>
</div>
</div>${dl}
</article>`;
}

// ---- page -------------------------------------------------------------------
// Every replacement that carries data is a function, so "$&", "$`" and "$'" in the data stay literal.
let html = await readFile(path.join(SRC, 'index.html'), 'utf8');
html = html.replace(/<!-- @if (\w+) -->\n?([\s\S]*?)<!-- @endif -->\n?/g, (_, key, body) => (cfg[key] ? body : ''));
const nowRows = games.map(nowRow).join('\n');
const gameCards = games.map(gameCard).join('\n');
html = html.replace('<!-- @now-rows -->', () => nowRows);
html = html.replace('<!-- @game-cards -->', () => gameCards);
html = html.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in cfg && cfg[key] ? esc(cfg[key]) : m));
const left = html.match(/\{\{\w+\}\}|<!-- @[\w-]+/);
if (left) fail(`unfilled placeholder left in the page: ${left[0]}`);

// ---- output (into the temp folder) ----------------------------------------------
// Same parent as OUT, so the final rename stays on one filesystem and is atomic. Plain mkdir (not
// mkdtemp) so the folder gets normal permissions; it fails if the name already exists.
await mkdir(path.dirname(OUT), { recursive: true });
const tmpPath = path.join(path.dirname(OUT), `.${path.basename(OUT)}-build-${process.pid}-${randomBytes(6).toString('hex')}`);
await mkdir(tmpPath);
tmp = tmpPath;
await writeFile(path.join(tmp, MARKER), MARKER_TEXT);
await mkdir(path.join(tmp, 'assets', 'fonts'), { recursive: true });

// Comment and whitespace strip only. Safe for this stylesheet: no strings rely on spacing.
const minifyCss = (css) => css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{};,])\s*/g, '$1')
  .replace(/;}/g, '}')
  .trim();

const hashed = {};
for (const rel of ['assets/site.css', 'assets/status.js']) {
  let buf = await readFile(path.join(SRC, rel));
  if (rel.endsWith('.css')) buf = Buffer.from(minifyCss(buf.toString('utf8')) + '\n');
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const out = rel.replace(/(\.\w+)$/, (ext) => `.${hash}${ext}`);
  await writeFile(path.join(tmp, out), buf);
  hashed[rel] = out;
  if (!html.includes(`"/${rel}"`)) fail(`index.html does not reference /${rel}`);
  html = html.replaceAll(`"/${rel}"`, () => `"/${out}"`);
}
await writeFile(path.join(tmp, 'index.html'), html);

const statics = ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'og.png', '_headers'];
for (const f of statics) await copyFile(path.join(SRC, f), path.join(tmp, f));
for (const f of await readdir(path.join(SRC, 'assets', 'fonts'))) {
  await copyFile(path.join(SRC, 'assets', 'fonts', f), path.join(tmp, 'assets', 'fonts', f));
}

if (sample) {
  const fixture = path.join(ROOT, 'fixtures', `status.${sample}.json`);
  const raw = JSON.parse(await readFile(fixture, 'utf8').catch(() => fail(`no fixture ${path.relative(ROOT, fixture)}`)));
  raw.updated = new Date(Date.now() - 3 * 60000).toISOString(); // keep "N min ago" realistic
  await writeFile(path.join(tmp, 'status.json'), JSON.stringify(raw, null, 2));
}

// ---- guard: brief §8, nothing private may ship ---------------------------------
// Words count only when no letter touches them, so "sonarr4k" and "radarr_movies" are caught
// and "zombie" or "localStorage" are not.
const PRIVATE_WORDS = [
  // media automation, downloaders and request apps
  'sonarr', 'radarr', 'prowlarr', 'lidarr', 'readarr', 'bazarr', 'whisparr', 'sabnzbd', 'nzbget', 'nzbhydra',
  'qbittorrent', 'jellyseerr', 'overseerr', 'seerr', 'ombi', 'requestrr', 'tautulli', 'jfa-?go',
  'flaresolverr', 'recyclarr', 'unpackerr',
  // server, network and home admin
  'dashboard', 'portainer', 'unraid', 'proxmox', 'pi-?hole', 'adguard', 'home[-_ ]?assistant', 'vaultwarden',
  'cockpit', 'webmin', 'grafana', 'uptime[-_ ]?kuma', 'ntfy', 'wol-?relay', 'localhost',
  // tailnet
  'tailnet', 'ts\\.net',
];
const FORBIDDEN = new RegExp([
  `(?<![a-z])(?:${PRIVATE_WORDS.join('|')})(?![a-z])`,
  '\\btail[0-9a-f]{4,}\\b', // MagicDNS tailnet name, e.g. tail1a2b3c
  'fd7a:115c:a1e0', // Tailscale IPv6 range
  '[a-z0-9-]+\\.(?:local|lan|internal|home\\.arpa)(?![a-z0-9-])', // LAN-only host names
].join('|'), 'i');
const PRIVATE_IP = /(?<![0-9])(10\.\d{1,3}|127\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?![0-9])/;
// Ports: any host in a URL (names, IPv4, [IPv6]), plus bare host.tld:port, IPv4:port and name:port.
const URL_PORT = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/?#@"'<>]*@)?(\[[0-9a-f:.]+\]|[^\s/?#:"'<>[\]]+):(\d+)/gi;
const BARE_PORT = /(?<![a-z0-9.-])((?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})(?![0-9])/gi;
// Single-label name:port in plain text, e.g. "mediaserver:8096". The name needs a letter and no ":"
// may follow the port, so times (10:30, 22:41:00, ISO timestamps) and ratios (16:9) still pass.
const NAME_PORT = /(?<![a-z0-9.:-])([a-z0-9-]*[a-z][a-z0-9-]*):(\d{2,5})(?![0-9a-z:])/gi;
const allowedPorts = new Set(games.map((g) => (String(g.address).match(/:(\d+)$/) || [])[1]).filter(Boolean));
const TEXT_FILE = /(\.(html|css|js|mjs|json|txt|svg|xml|webmanifest|map)|^_headers|^_redirects)$/i;

async function textFiles(dir, base = dir) {
  const found = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...await textFiles(full, base));
    else if (TEXT_FILE.test(e.name)) found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found.sort();
}

for (const rel of await textFiles(tmp)) {
  const text = await readFile(path.join(tmp, rel), 'utf8');
  const word = text.match(FORBIDDEN);
  if (word) fail(`${rel} mentions "${word[0]}", which must not appear on the public page.`);
  const ip = text.match(PRIVATE_IP);
  if (ip) fail(`${rel} contains a private address (${ip[0]}).`);
  for (const re of [URL_PORT, BARE_PORT, NAME_PORT]) {
    for (const m of text.matchAll(re)) {
      if (!allowedPorts.has(m[2])) fail(`${rel} exposes port ${m[2]} (${m[0]}); only game ports are allowed.`);
    }
  }
}

// ---- size report ----------------------------------------------------------------
const report = [];
let total = 0;
const budgeted = ['index.html', hashed['assets/site.css'], hashed['assets/status.js'], 'favicon.svg',
  ...(await readdir(path.join(tmp, 'assets', 'fonts'))).filter((f) => f.endsWith('.woff2')).map((f) => `assets/fonts/${f}`)];
for (const rel of budgeted) {
  const buf = await readFile(path.join(tmp, rel));
  total += buf.length;
  report.push(`  ${rel.padEnd(34)} ${String(buf.length).padStart(7)} B   gzip ${String(gzipSync(buf).length).padStart(6)} B`);
}

// ---- every check passed: swap the new build into place --------------------------
try {
  removeOld(); // only if it is still the folder the checks accepted
  renameSync(tmp, OUT);
} catch (e) {
  fail(`could not put the new build at ${OUT} (${e.code || e.message}). Whatever is there now was left alone.`);
}
committed = true;

console.log(`build: wrote ${shown(OUT)}`);
console.log(report.join('\n'));
console.log(`  ${'total before images'.padEnd(34)} ${String(total).padStart(7)} B   budget ${BUDGET_BYTES} B`);
if (total > BUDGET_BYTES) console.warn('build: warning, over the 100 KB budget.');
if (sample) console.log(`build: sample status "${sample}" written to ${shown(path.join(OUT, 'status.json'))} (local preview only)`);
