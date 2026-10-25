#!/usr/bin/env node
// Mutation check: breaks one guard at a time in a temporary copy of this folder and confirms
// the test suite notices. Offline; nothing in this folder is modified.
//   npm run mutate
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SITE } = await import('./helpers/site.mjs');

const MUTATIONS = [
  { name: 'watch follows redirects', file: 'src/watch.js',
    find: "redirect: 'manual'", replace: "redirect: 'follow'" },
  { name: 'any non-empty 200 body counts as Healthy', file: 'src/watch.js',
    find: "text.trim() === 'Healthy'", replace: "text.trim() !== ''" },
  { name: 'over-long VarInt treated as incomplete', file: 'src/minecraft.js',
    find: "throw new ProtocolError('VarInt is longer than 5 bytes');", replace: 'return null;' },
  { name: 'VarInt 32-bit width check removed', file: 'src/minecraft.js',
    find: 'if (i === MAX_VARINT_BYTES - 1 && byte & 0x70)', replace: 'if (false)' },
  { name: '64 KiB response cap loosened', file: 'src/minecraft.js',
    find: 'len.size + len.value > maxBytes', replace: 'len.size + len.value > maxBytes * 16' },
  { name: 'player counts not validated', file: 'src/minecraft.js',
    find: 'return Number.isInteger(n) && n >= 0 && n <= MAX_PLAYERS ? n : null;', replace: "return typeof n === 'number' ? n : null;" },
  { name: 'closed-before-a-byte reported as unknown, not offline', file: 'src/minecraft.js',
    find: 'if (chunk.done) return received ? UNKNOWN() : OFFLINE();', replace: 'if (chunk.done) return UNKNOWN();' },
  { name: 'method guard loosened (POST allowed)', file: 'src/handler.js',
    find: "if (method !== 'GET' && method !== 'HEAD')", replace: "if (method === 'DELETE')" },
  { name: 'notice length guard loosened', file: 'src/handler.js',
    find: 'if (!problem && Array.from(text).length > MAX_NOTICE_CHARS)', replace: 'if (!problem && text.length > MAX_NOTICE_CHARS * 10)' },
  { name: 'notice control/bidi/invisible check removed', file: 'src/handler.js',
    find: 'if (NOTICE_FORBIDDEN.test(raw)) problem', replace: 'if (false) problem' },
  { name: 'version text not restricted to version characters', file: 'src/minecraft.js',
    find: 'return VERSION_RE.test(text) ? text : null;', replace: 'return text || null;' },
  { name: 'cache freshness check removed', file: 'src/handler.js',
    find: 'return age >= 0 && age <= ttlSeconds * 1000;', replace: 'return true;' },
  { name: 'isolate memory never expires', file: 'src/handler.js',
    find: 'if (iso && iso.snapshot && isFresh(iso.snapshot.at, deps.now(), ttlSeconds)) return iso.snapshot;', replace: 'if (iso && iso.snapshot) return iso.snapshot;' },
  { name: 'stampede guard removed (every request probes)', file: 'src/handler.js',
    find: 'if (iso && iso.round && deps.now() - iso.round.since < roundLimit(deps)) {', replace: 'if (false) {' },
  { name: 'a waiter probes again even with no time left', file: 'src/handler.js',
    find: 'if (waitedMs + roundLimit(deps) > (deps.responseBudgetMs ?? RESPONSE_BUDGET_MS)) return unknownSnapshot(deps.now());', replace: '' },
  { name: 'index.js drops the isolate state', file: 'src/index.js',
    find: '      isolate,\n', replace: '' },
  { name: 'cache TTL floor removed', file: 'src/handler.js',
    find: 'Math.max(MIN_CACHE_SECONDS, n)', replace: 'n' },
  { name: 'last-resort error leaks the stack', file: 'src/handler.js',
    find: `return json(503, '{"error":"unavailable"}');`, replace: 'return json(500, JSON.stringify({ error: String(err && err.stack) }));' },
  { name: 'probe target taken from the request (SSRF)', file: 'src/handler.js',
    find: 'const snap = await getSnapshot(deps, ctx, cacheSeconds(env));',
    replace: "const h = url.searchParams.get('host'); if (h) deps = { ...deps, connect: (a, o) => deps.connect({ ...a, hostname: h }, o) };\n    const snap = await getSnapshot(deps, ctx, cacheSeconds(env));" },
  { name: 'wrangler unpinned (^ range)', file: 'package.json',
    find: '"wrangler": "4.123.0"', replace: '"wrangler": "^4.123.0"' },
  { name: 'game list drifts from site/content/games.json', file: 'src/games.js',
    find: "name: 'Minecraft Hardcore'", replace: "name: 'Minecraft'" },
  { name: 'probes run one after the other', file: 'src/handler.js',
    find: '  const [watch, ...games] = await Promise.all([\n    settleProbe(() => probeWatch({ fetch: deps.fetch, timeoutMs }), limit),\n    ...GAMES.map((g) => settleProbe(() => probeGame(g, deps.connect, timeoutMs), limit)),\n  ]);',
    replace: '  const watch = await settleProbe(() => probeWatch({ fetch: deps.fetch, timeoutMs }), limit);\n  const games = [];\n  for (const g of GAMES) games.push(await settleProbe(() => probeGame(g, deps.connect, timeoutMs), limit));' },
  { name: 'a bidi control character slips into the source', file: 'src/games.js',
    find: 'export const PROBE_TYPES', replace: `// ${String.fromCharCode(0x202e)}\nexport const PROBE_TYPES` },
  { name: 'Zomboid gets a TCP probe', file: 'src/games.js',
    find: "address: 'game.homebknet.us:16261', probe: 'none'", replace: "address: 'game.homebknet.us:16261', probe: 'minecraft-java'" },
];

function runSuite(dir) {
  const files = readdirSync(path.join(dir, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, encoding: 'utf8', timeout: 180000 });
  const failing = [...(r.stdout || '').matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { ok: r.status === 0, failing };
}

const root = await mkdtemp(path.join(tmpdir(), 'hb-worker-mutate-'));
const copy = path.join(root, 'worker');
const fresh = async () => {
  await rm(copy, { recursive: true, force: true });
  await cp(WORKER, copy, { recursive: true, filter: (src) => !/[\\/](node_modules|\.wrangler)([\\/]|$)/.test(src) });
};

let bad = 0;
try {
  await symlink(SITE, path.join(root, 'site'), 'dir');
  await fresh();
  const base = runSuite(copy);
  if (!base.ok) {
    console.error(`baseline fails before any mutation: ${base.failing.join('; ')}`);
    process.exit(1);
  }
  console.log('baseline: all tests pass\n');
  for (const m of MUTATIONS) {
    await fresh();
    const file = path.join(copy, m.file);
    const src = await readFile(file, 'utf8');
    const hits = src.split(m.find).length - 1;
    if (hits !== 1) {
      bad++;
      console.log(`INVALID   ${m.name} (pattern found ${hits} times in ${m.file})`);
      continue;
    }
    await writeFile(file, src.replace(m.find, m.replace));
    const r = runSuite(copy);
    if (r.ok) bad++;
    const which = r.failing.filter((n) => !/^test\//.test(n)).slice(0, 2).join('; ');
    console.log(`${r.ok ? 'SURVIVED' : 'caught  '}  ${m.name}${r.ok ? '' : ` (${r.failing.length} failing, e.g. ${which})`}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(`\n${MUTATIONS.length - bad} of ${MUTATIONS.length} mutations caught`);
process.exit(bad ? 1 : 0);
