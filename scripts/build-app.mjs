// Builds app/ into site/app/, so the new UI deploys alongside the captured upstream page
// instead of replacing it outright.
//
// Same origin is the point, not just convenience: the deployed site keeps its osu! token in
// localStorage, which is per-origin. Serving the new UI from a path on the same Worker is what
// lets it read that token and load real online scores — something the :8900 dev server can
// never do.
//
// Output lands in site/app/, which is gitignored along with the rest of site/ and rebuilt by
// this script. capture:upstream does not touch that subdirectory.
//
// Run: node scripts/build-app.mjs

import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const APP_DIR = 'app';
const OUT_DIR = path.join('site', 'app');

/** Page entry points: each .html plus the module it loads. */
const PAGES = ['dev.html', 'preview.html'];

/** Module entry points, mirrored so the pages' import paths keep working. */
const ENTRIES = [
  'player/flow.ts',
  'player/load.ts',
  'player/settings.ts',
  'player/transport.ts',
  'player/volume-meter.ts',
  'player/menubar.ts',
  'player/osuApi.ts',
  'player/auth.ts',
  'player/skins.ts',
  'player/match.ts',
  'player/matchRoom.ts',
  'player/matchView.ts',
  'results/panel.ts',
  'results/icons.ts',
  'results/reveal.ts',
  'results/accuracyCircle.ts',
  'results/accuracyGauge.ts',
  'results/animate.ts',
  'results/theme.ts',
];

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

// Each module is bundled separately rather than into one file: the pages import them by path
// (`./results/panel.js`), and rewriting those imports to a single bundle would mean editing the
// HTML at build time for no gain — the shared code is small and esbuild dedupes nothing across
// separate entry points, but the pages only load what they reference.
await esbuild.build({
  entryPoints: ENTRIES.map(e => path.join(APP_DIR, e)),
  outdir: OUT_DIR,
  bundle: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  minify: true,
});

for (const page of PAGES) {
  await fs.copyFile(path.join(APP_DIR, page), path.join(OUT_DIR, page));
}

// Fonts are optional and gitignored; copy them when the developer supplied them.
const fontsFrom = path.join(APP_DIR, 'fonts');
try {
  const names = await fs.readdir(fontsFrom);
  if (names.length > 0) {
    await fs.mkdir(path.join(OUT_DIR, 'fonts'), { recursive: true });
    for (const name of names) {
      await fs.copyFile(path.join(fontsFrom, name), path.join(OUT_DIR, 'fonts', name));
    }
    console.log(`copied ${names.length} font file(s)`);
  }
} catch {
  console.log('app/fonts/ absent — the pages fall back to Quicksand');
}

// The dev pages reach /assets/... for the sample skin and default hitsounds. On the deployed
// Worker the skins live under /skins/, so a copy is placed where the pages already look rather
// than rewriting their URLs — which would diverge the dev and deployed builds.
const assetPairs = [
  [path.join('assets', 'skin'), path.join(OUT_DIR, '..', 'assets', 'skin')],
  [path.join('assets', 'lazer-defaults'), path.join(OUT_DIR, '..', 'assets', 'lazer-defaults')],
];
for (const [from, to] of assetPairs) {
  await fs.cp(from, to, { recursive: true });
}

const built = await fs.readdir(OUT_DIR);
console.log(`built ${OUT_DIR}/ (${built.length} entries) — pages: ${PAGES.join(', ')}`);
