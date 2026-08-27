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
  'player/playerLoader.ts',
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
  'player/difficultyPicker.ts',
  'player/uiSounds.ts',
  'player/notifications.ts',
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

// `splitting` is not optional here. Without it esbuild inlines a shared module into *every*
// entry that imports it, and uiSounds.ts ends with a module-level side effect — it constructs a
// manager and preloads samples. Eleven bundles each carried their own copy, so a page importing
// five of them built five managers, ran five preloads (measured: 181 requests for 37 distinct
// URLs, 32 MB) and left the mute toggle acting on only one of them. Splitting gives every entry
// the same instance.
await esbuild.build({
  entryPoints: ENTRIES.map(e => path.join(APP_DIR, e)),
  outdir: OUT_DIR,
  bundle: true,
  splitting: true,
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
// One destination per source. There were nine pairs here, six of them copying the same bytes to
// alternative spellings (`Samples`, `samples`, `ui-sounds/Results`, …) so that a seven-candidate
// URL cascade in uiSounds.ts would find *something*. Both sides of that are gone: every sample
// name resolves inside assets/ui-sounds by basename, so the loader asks for one URL and a missing
// file is a real error rather than six more requests.
const assetPairs = [
  [path.join('assets', 'skin'), path.join(OUT_DIR, '..', 'assets', 'skin')],
  [path.join('assets', 'lazer-defaults'), path.join(OUT_DIR, '..', 'assets', 'lazer-defaults')],
  [path.join('assets', 'ui-sounds'), path.join(OUT_DIR, '..', 'assets', 'ui-sounds')],
];

// Runtime sound manifest. The build fails here instead of shipping a UI where an interaction
// produces a late 404. Result sounds stay in this manifest but out of uiSounds.preload(), so they
// are deployed once and fetched only when the reveal reaches them.
const requiredUiSounds = [
  'button-hover', 'button-select', 'button-sidebar-hover', 'button-sidebar-select',
  'default-hover', 'default-select', 'default-select-disabled', 'check-on', 'check-off',
  'dialog-pop-in', 'dialog-pop-out', 'dialog-ok-select', 'dialog-cancel-select',
  'dialog-dangerous-select', 'dropdown-open', 'dropdown-close', 'menu-open', 'menu-close',
  'menu-sub-open', 'generic-error', 'notification-default', 'notification-error',
  'notification-done', 'notch-tick', 'osd-change', 'osd-on', 'osd-off',
  'overlay-big-pop-in', 'overlay-big-pop-out', 'overlay-pop-in',
  'score-panel-focus', 'score-panel-top-appear', 'swoosh-up', 'score-tick',
  'badge-dink', 'badge-dink-max', 'rank-impact-pass-ss', 'rank-impact-pass',
  'rank-impact-fail', 'rank-impact-fail-d', 'applause-s', 'applause-a', 'applause-b',
  'applause-c', 'applause-d',
];
for (const sample of requiredUiSounds) {
  const source = path.join('assets', 'ui-sounds', `${sample}.wav`);
  try {
    await fs.access(source);
  } catch {
    throw new Error(`missing canonical UI sound: ${source}`);
  }
}

// Cleared first, not merged into. This script only ever *added* to site/assets, so dropping the
// six redundant copy destinations left 100 MB of them sitting there — the deploy stayed heavy
// after the source stopped producing them. site/assets is entirely ours (capture:upstream writes
// site/skins and the page files, never this), so wiping it is safe and makes the build's output a
// function of its input rather than of everything it has ever copied.
await fs.rm(path.join('site', 'assets'), { recursive: true, force: true });
for (const [from, to] of assetPairs) {
  await fs.cp(from, to, { recursive: true });
}

const built = await fs.readdir(OUT_DIR);
console.log(`built ${OUT_DIR}/ (${built.length} entries) — pages: ${PAGES.join(', ')}`);
