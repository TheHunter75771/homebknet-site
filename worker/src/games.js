/*
 * The game servers the Worker reports on.
 *
 * id, name and address mirror the site's content/games.json, which is the source of truth.
 * test/config.test.mjs fails if the two drift apart, so add a server there first, then here.
 *
 * `probe` is the only Worker-specific field:
 *   minecraft-java  Java Edition Server List Ping over TCP (cloudflare:sockets)
 *   none            never probed; always reported as "unknown"
 *
 * Project Zomboid is `none` because its server talks UDP only (16261), and a Worker can only
 * open outbound TCP sockets. No TCP port says whether the Zomboid server is up, so the honest
 * answer is "unknown" until a push-based source exists.
 *
 * These are the only addresses the Worker ever connects to. Nothing in a request can change them.
 */
import { HOSTNAME_RE } from './minecraft.js';

export const PROBE_TYPES = Object.freeze(['minecraft-java', 'none']);

export const GAMES = Object.freeze([
  Object.freeze({ id: 'mc-hardcore', name: 'Minecraft Hardcore', address: 'game.homebknet.us:25565', probe: 'minecraft-java' }),
  Object.freeze({ id: 'zomboid', name: 'Project Zomboid', address: 'game.homebknet.us:16261', probe: 'none' }),
]);

// "host:port" to { hostname, port }. Throws on anything else (no IPv6 brackets, no paths).
export function parseAddress(address) {
  const m = typeof address === 'string' ? /^([^:\s/]+):(\d{1,5})$/.exec(address) : null;
  if (!m || !HOSTNAME_RE.test(m[1])) throw new RangeError('address must be host:port');
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new RangeError('port out of range');
  return { hostname: m[1].toLowerCase(), port };
}
