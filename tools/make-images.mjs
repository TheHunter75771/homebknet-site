// Regenerates the raster images in src/ from SVG: apple-touch-icon.png, favicon.ico, og.png.
// Run once after changing the mark or the social image:
//   python3 font-instances.py && npm run images
// favicon.ico also needs ImageMagick (convert or magick) on PATH.

import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const FONTS = [path.join(HERE, '.cache', 'Inter-Bold.ttf'), path.join(HERE, '.cache', 'Inter-SemiBold.ttf')];

function render(svg, width, withFonts = false) {
  const opts = { fitTo: { mode: 'width', value: width }, background: 'rgba(0,0,0,0)' };
  if (withFonts) opts.font = { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' };
  return new Resvg(svg, opts).render().asPng();
}

// iOS rounds the corners itself, so the tile is full bleed.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" fill="#161826"/>
<path d="M16 6.8 25.2 14.1V24a1.2 1.2 0 0 1-1.2 1.2H8A1.2 1.2 0 0 1 6.8 24V14.1Z" fill="#9184d9" stroke="#9184d9" stroke-width="2.4" stroke-linejoin="round"/>
<path d="M14.2 16.7v6.6l5.7-3.3Z" fill="#161826" stroke="#161826" stroke-width="1.3" stroke-linejoin="round"/>
</svg>`;

const mark = (x, y, size, door) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 32 32">
<path d="M16 4.5 27.5 13.6V26a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 26V13.6Z" fill="#9184d9" stroke="#9184d9" stroke-width="3" stroke-linejoin="round"/>
<path d="M13.8 16.2v8.2l7.1-4.1Z" fill="${door}" stroke="${door}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

const pill = (x, w, label) => `<rect x="${x}" y="438" width="${w}" height="46" rx="23" fill="#2b2741"/>
<text x="${x + w / 2}" y="469" text-anchor="middle" font-family="Inter" font-weight="600" font-size="22" fill="#d2cefd">${label}</text>`;

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#161826"/>
${mark(80, 143, 76, '#161826')}
<text x="176" y="204" font-family="Inter" font-weight="700" font-size="64" letter-spacing="-2.9" fill="#e9e9ed">homebknet</text>
<g font-family="Inter" font-weight="600" font-size="46" letter-spacing="-1.4" fill="#e9e9ed">
<text x="80" y="291">Movies, shows and game</text>
<text x="80" y="343">servers for friends</text>
<text x="80" y="395">and family.</text>
</g>
${pill(80, 104, 'Watch')}
${pill(196, 182, 'Game servers')}
${pill(390, 130, 'Is it up?')}
<svg x="780" y="145" width="340" height="340" viewBox="0 0 52 52">
<rect width="52" height="52" rx="13" fill="#2b2741"/>
<circle cx="37" cy="15" r="6" fill="#e7e5fe"/><circle cx="39.6" cy="12.8" r="5" fill="#2b2741"/>
<circle cx="12" cy="13" r="0.9" fill="#cfd3e5"/><circle cx="20.5" cy="8.5" r="0.7" fill="#9397ab"/><circle cx="27" cy="12" r="0.5" fill="#cfd3e5"/>
<path d="M12 29.5 26 19l14 10.5V41a1.5 1.5 0 0 1-1.5 1.5h-25A1.5 1.5 0 0 1 12 41Z" fill="#5d5294" stroke="#5d5294" stroke-width="2" stroke-linejoin="round"/>
<rect x="22" y="30.5" width="8" height="8" rx="2" fill="#f0bf6c"/>
</svg>
</svg>`;

const favicon = await readFile(path.join(SRC, 'favicon.svg'), 'utf8');

await writeFile(path.join(SRC, 'apple-touch-icon.png'), render(appIcon, 180));
console.log('wrote src/apple-touch-icon.png');

await writeFile(path.join(SRC, 'og.png'), render(og, 1200, true));
console.log('wrote src/og.png');

const tmp = await mkdtemp(path.join(tmpdir(), 'hb-ico-'));
try {
  const sizes = [16, 32, 48];
  const pngs = [];
  for (const s of sizes) {
    const p = path.join(tmp, `${s}.png`);
    await writeFile(p, render(favicon, s));
    pngs.push(p);
  }
  const bin = ['magick', 'convert'].find((b) => { try { execFileSync(b, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!bin) throw new Error('ImageMagick not found; favicon.ico not updated');
  execFileSync(bin, [...pngs, path.join(SRC, 'favicon.ico')]);
  console.log('wrote src/favicon.ico');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
