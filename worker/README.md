# homebknet-status Worker

The Cloudflare Worker behind `https://homebknet.us/status.json`. The homepage's `status.js` fetches that
file every 60 seconds and fills in the status chips. The Worker is routed on that one path only; everything
else on `homebknet.us` stays on Cloudflare Pages. It has no runtime dependencies (plain ES modules).

The response shape is the one in the site's `fixtures/status.normal.json`:

```json
{ "updated": "2026-10-25T18:30:00Z",
  "watch": { "state": "online" },
  "games": [{ "id": "mc-hardcore", "name": "Minecraft Hardcore", "address": "game.homebknet.us:25565",
              "state": "online", "players": 2, "maxPlayers": 20, "version": "26.1.2" }, "..."],
  "notice": null }
```

`state` is `online`, `offline`, `starting` or `unknown`. `updated` is when the probes ran.

## What it checks

| Service | How | Result |
| --- | --- | --- |
| Watch (Jellyfin) | `GET https://watch.homebknet.us/watch/health` through the tunnel, 4 s timeout, redirects not followed | `200` with body `Healthy` is **online**. Any other status (502/503/530 from the tunnel, 3xx, 4xx), any other body, or no answer in 4 s is **offline**. Only a failure inside the Worker itself (fetch throwing) is **unknown**. |
| Minecraft Hardcore | Java Edition Server List Ping over TCP to `game.homebknet.us:25565` (`cloudflare:sockets`), 4 s timeout, response capped at 64 KiB | A valid status response is **online**, with `players.online`, `players.max` and `version.name`. Counts must be whole numbers from 0 to 100,000; the version must be letters, digits, spaces and `. + _ -`, at most 32 characters. Anything else becomes `null`. Refused, reset, closed or silent is **offline** (the game PC is often asleep; the page shows "Asleep"). An answer that isn't a usable status (truncated, oversize, garbage, stalled halfway) is **unknown**. |
| Project Zomboid | Not probed | Always **unknown**. See below. |

The game list is `src/games.js`. Its `id`, `name` and `address` mirror the site's `content/games.json`,
and a test fails if the two disagree. Each game also has a `probe`: `minecraft-java` or `none`.

The Worker never emits `starting`. A Minecraft server that is still loading typically drops status
pings without a reply, which looks the same as a dead relay, so the Worker reports `offline` rather
than guess.

### Why Project Zomboid is unknown

The Zomboid server talks UDP only (port 16261). Workers can open outbound TCP sockets but cannot send
UDP, so there is nothing the Worker can ask. Rather than guess, it reports `unknown`, and the page says
"Can't check this one right now. It might still be running." Showing a real state needs a push-based
source (the game PC reporting in), which doesn't exist yet.

## Behaviour and safety

- **Caching.** One probe round is reused for `CACHE_SECONDS` (default 30, clamped to 30..60): first from
  the isolate's memory, then from the data center's Cache API under a fixed internal key. The notice
  isn't cached; a change shows on the next request.
- **One round at a time.** While a round is running, other requests in the same isolate wait for its
  result (polling the isolate's memory on their own timers, up to that round's 4.5 s deadline) instead of
  probing too. If the round dies without a result, a waiter probes itself when that still fits under the
  page's 6 s timeout, and otherwise answers `unknown` (never cached). Separate isolates don't share this,
  so a burst can still cost one round per isolate; Cloudflare's per-account request limits cap the rest.
- **Fixed targets.** The only hosts it contacts are in `src/watch.js` and `src/games.js`. Nothing in the
  request (path, query, headers) changes them.
- **Methods.** `GET` and `HEAD` on `/status.json`. Other methods get `405`, other paths `404`.
- **Failures stay local.** A probe that throws or hangs makes only its own entry `unknown`; the response is
  still `200` with the full document. Error details go to the Worker log, never into the response. If the
  handler itself breaks, the answer is a bare `503 {"error":"unavailable"}`, which the page shows as
  "Status unavailable".
- **Headers.** `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a
  `default-src 'none'` CSP. No CORS headers (the page is same-origin).
- **No workers.dev address** and no preview URLs, so the only way in is the route.

## Tests

```bash
cd worker
npm test          # node --test, offline; no install needed
npm run mutate    # breaks 27 guards one at a time and checks the tests catch each one
```

`fetch`, `connect` and `caches.default` are all faked, so nothing touches the network. One group of tests
feeds the Worker's output through the site's real `status.js` in jsdom. It needs the site's dev tools
installed (`npm install` in the site's `tools/`) and is skipped otherwise. The shape checks against every
fixture always run.

A privacy test fails on private addresses, admin app names or private-network names anywhere in this
folder. To also check words that must never be published but can't be listed in a public file, put them
in `test/private-words.local.txt`, one per line (`#` starts a comment). That file is git-ignored; the test
runs when it exists and is skipped otherwise.

## Deploy

Before you start, `homebknet.us` must be on the Cloudflare account you sign in with. The route only
runs once the apex has a proxied DNS record; the Pages custom domain creates one. Deploying needs Node 22
or newer (wrangler's requirement); the tests alone run on Node 20.

```bash
cd worker
npm ci                # installs the pinned wrangler from package-lock.json, for deploying only
npm test
npx wrangler login    # opens a browser; sign in to the account that has homebknet.us
npx wrangler deploy
```

`wrangler deploy` uploads the Worker, sets the three vars from `wrangler.toml`, and adds the route
`homebknet.us/status.json`. Run `npm run check` first if you want to see the bundle without uploading.

`wrangler` is pinned to an exact version because it holds the Cloudflare login. `compatibility_date` is
the date that version's bundled runtime declares (`node -p "require('workerd').compatibilityDate"`
after `npm ci`); a test fails if it's newer than the locked runtime. `package.json` also pins `undici`
through `overrides`, because the wrangler release ships an older one with known advisories; it is only
used by wrangler's local runtime, never by the deployed Worker.

To upgrade: set the new wrangler version in `package.json`, run `npm install`, set `compatibility_date`
to the new `workerd` date, check `npm audit` (drop or raise the `undici` override if the new release no
longer needs it), then `npm test` and `npm run check`.

## Maintenance notice

The banner at the top of the homepage comes from two vars:

- `NOTICE_TEXT`: plain text, at most 200 characters. Line breaks fold to spaces. `&`, `<` and `>` are fine;
  the page shows them as typed.
- `NOTICE_LEVEL`: `info` (default) or `warn`.

Text with control, bidi or invisible characters, or over 200 characters, is dropped rather than shown
half-right (`npx wrangler tail homebknet-status` shows why). Empty means no banner.

From the terminal (quote each `KEY:value`; colons in the text are fine):

```bash
npx wrangler deploy --var "NOTICE_TEXT:Planned maintenance tonight, 11 pm to midnight." --var NOTICE_LEVEL:info
npx wrangler deploy   # clears it again (wrangler.toml has an empty NOTICE_TEXT)
```

Or in the Cloudflare dashboard: Workers & Pages > homebknet-status > Settings > Variables and Secrets,
edit `NOTICE_TEXT` (and `NOTICE_LEVEL`), then deploy. The next `npx wrangler deploy` puts the
`wrangler.toml` values back, which clears a dashboard notice.

## Verify after deploying

```bash
curl -sI https://homebknet.us/status.json | grep -iE '^(content-type|cache-control):'
# content-type: application/json; charset=utf-8
# cache-control: no-store
curl -s https://homebknet.us/status.json
```

Those two headers together prove the Worker answered. If you see `content-type: text/html`, Pages
answered instead: the route isn't active yet (no proxied DNS record for the apex, or the deploy didn't
run). In the body, `updated` should be within the last minute, and Minecraft should show `offline` while
the game PC is asleep.

If Watch shows `offline` while Jellyfin works in a browser, check that the tunnel serves
`https://watch.homebknet.us/watch/health` and that no WAF or bot rule blocks requests without a browser.

If Minecraft is always `offline` even while you're playing, check that `game.homebknet.us` is still
DNS-only (grey cloud). Workers can't open sockets to Cloudflare-proxied addresses, so a proxied record
makes every ping fail.

## Adding a game server

1. Add it to the site's `content/games.json` (that's the source of truth).
2. Add the same `id`, `name` and `address` to `src/games.js`, with `probe: 'minecraft-java'` for a Java
   Edition server or `probe: 'none'` for anything else.
3. `npm test`, then `npx wrangler deploy`.

## Files

```
src/index.js        entry: wires fetch, cloudflare:sockets, caches.default and the isolate state in
src/handler.js      /status.json: routing, isolate memory and Cache API, notice, headers, the document
src/watch.js        Jellyfin health probe
src/minecraft.js    VarInt, Server List Ping packets, response parsing and validation
src/games.js        the game list and each game's probe type
test/               node:test suites, fakes in test/helpers/, mutation runner in mutations.mjs
wrangler.toml       name, route, vars
package-lock.json   the pinned wrangler and its dependencies (dev only)
```

References: [TCP sockets in Workers](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/),
[Server List Ping](https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping).
