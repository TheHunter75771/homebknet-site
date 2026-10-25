// Where the homepage lives: next to this folder (homebknet-site/site and homebknet-site/worker),
// or around it (worker/ inside the site repo). Tests fail loudly if neither layout matches.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANDIDATES = [path.join(WORKER, '..', 'site'), path.join(WORKER, '..')];
export const SITE = CANDIDATES.map((d) => path.resolve(d)).find((d) => existsSync(path.join(d, 'content', 'games.json')));
if (!SITE) throw new Error(`site not found (looked for content/games.json in ${CANDIDATES.join(' and ')})`);
