# homebknet.us homepage

The public front door: how to watch, how to join a game server, and whether it's up.
This is a static site for Cloudflare Pages. It works fully without JavaScript; `status.js` only fills in live status.

## Layout

```
build.mjs              builds dist/ (no dependencies, Node 20+); --sample-status builds preview/
content/games.json     game server cards; add a server here, no redesign needed
src/index.html         page template
src/assets/site.css    all styles (no inline styles, so the CSP stays strict)
src/assets/status.js   live status, copy buttons, notice banner
src/assets/fonts/      Inter variable, Latin subset, plus its licence (OFL)
src/_headers           CSP and caching for Cloudflare Pages
src/*.png, *.ico, *.svg  favicon, iPhone icon, social preview image
fixtures/              sample status.json files for local preview and tests
tools/                 dev only: tests and the image generator
.github/workflows/     CI: tests, a clean build, and a gitleaks scan of the full history
LICENSE                MIT, for the code (the font has its own licence, see below)
```

## Build settings

Personal details never live in the repo. The build fills them in from environment variables.

| Variable | Required | Example |
| --- | --- | --- |
| `OWNER_FIRST_NAME` | yes | the name friends text |
| `CONTACT_EMAIL` | yes | your mail alias |
| `SITE_URL` | no | `https://homebknet.us` (default) |
| `OUTPOST_URL` | no | leave unset to hide the Outpost Tech slot |
| `PORTFOLIO_URL` | no | leave unset to hide the About me button |
| `OUT_DIR` | no | default `dist`, or `preview` with `--sample-status` |

The build stops with exit code 1 if a required value is missing, a placeholder is left behind, or any
text file in the output mentions something on the brief's private list. That covers admin app names
(Sonarr, Portainer, Grafana and the rest, even inside longer words like `sonarr4k`), tailnet names and
the Tailscale address ranges, private and LAN addresses and host names, and any `host:port` (names,
including single-label ones like `server:8096`, IPv4 or IPv6) whose port isn't one of the game ports
in `content/games.json`. Times like `10:30` and ratios like `16:9` are fine.

The build writes into a hidden temp folder next to `dist/` and renames it to `dist/` only after every
check passes. If anything fails, or the build is interrupted, the temp folder is removed **and so is
any previous `dist/`**. After a failed build there is no `dist/` at all, so an older build can't be
deployed by mistake.

The build only ever removes or replaces a folder it made itself. Every build writes a
`.homebknet-build` marker into its output: a fixed signature plus a hash of this repo's path, keyed
with a random secret in the git-ignored `.cache/build-key` (the marker is published with the site, and
the key stops anyone confirming a guessed local path). An `OUT_DIR` that is a symlink, a file, or a
non-empty folder without this repo's marker is refused and left untouched. That includes a build
from another copy of the repo, or one made before `.cache/` was cleared; delete those by hand. An
empty folder is fine.

## Build and preview locally (Fedora)

```bash
cd ~/homebknet-site
OWNER_FIRST_NAME='Name' CONTACT_EMAIL='alias@example.com' npm run preview
# open http://localhost:8788
```

`npm run preview` builds with `--sample-status=normal` and serves the result. A sample build writes to
`preview/` (git-ignored) with a fake `status.json`, and it never writes to `dist/`, so the sample can't
be deployed. Other samples: `--sample-status=badnight`, `--sample-status=maintenance`. To see the
"Status unavailable" state (what visitors without JavaScript get), build without the flag and serve
`dist/` the same way.

## Deploy to Cloudflare Pages

Option A, connected to the GitHub repo (redeploys on every push):

1. Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git, pick the repo.
2. Build settings:
   - Framework preset: None
   - Build command: `node build.mjs`
   - Build output directory: `dist`
   - Root directory: the folder this README is in, if it lives inside another repo
3. Settings > Environment variables: add the variables above for Production, plus `NODE_VERSION` = `22`
   (the version CI tests with).
4. Custom domains: add `homebknet.us` once Jellyfin has moved to `watch.homebknet.us` (ADR 0016).
5. Leave Web Analytics off. The CSP would block its beacon anyway.

Option B, direct upload from your machine:

```bash
cd ~/homebknet-site
OWNER_FIRST_NAME='Name' CONTACT_EMAIL='alias@example.com' node build.mjs && npx wrangler pages deploy dist --project-name homebknet
```

The `&&` matters: a failed build exits 1 and leaves no `dist/`, so nothing is uploaded.

## Live status

The page fetches `/status.json` from its own origin every 60 seconds while the tab is visible.
Nothing in `dist/` provides that file in production; the Cloudflare Worker does. The shape is in
`fixtures/status.normal.json`.

- Route the Worker on `homebknet.us/status.json`, return `Content-Type: application/json` and
  `Cache-Control: no-store` (or a short max-age).
- After deploying, check that the Worker answers, not Pages:
  `curl -sI https://homebknet.us/status.json | grep -i content-type`
- Game entries match cards by `id`. A card with no matching entry shows Unknown.
- `STALE_MINUTES` at the top of `status.js` is 0 (off). Set it to treat old data as unavailable.

## Adding a game server

Add an object to `content/games.json` with an `id`, `name`, `address` and optional `game`,
`version`, `mods` and `rules`, then give the Worker's `games` list an entry with the same `id`.
Fields left as `null` are simply left out of the card.

## Tests and images (dev only)

```bash
cd ~/homebknet-site/tools
npm ci                                    # installs exactly what package-lock.json pins
npm test                                  # build and privacy-guard checks, then status.js in jsdom
pip install --user fonttools brotli
python3 font-instances.py && npm run images   # only after changing the mark or the social image
```

CI (`.github/workflows/ci.yml`) runs the same tests and a clean build on every push and pull request
to `main`, plus a gitleaks scan of the full git history.

## Licence

The code is under the MIT licence (`LICENSE`). The Inter font is under the SIL Open Font License 1.1;
its licence is in `src/assets/fonts/OFL.txt` and is shipped next to the font in `dist/`.
