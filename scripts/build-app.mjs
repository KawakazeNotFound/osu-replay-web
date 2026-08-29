// Builds app/ into site/ so the modern UI is served as the default homepage (/)
// and at /replay, while maintaining /app/dev for backwards compatibility.
//
// Output lands in site/ (and site/app/), which is gitignored along with the rest of site/.
//
// Run: node scripts/build-app.mjs

import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const APP_DIR = 'app';
const SITE_DIR = 'site';

/** Module entry points */
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
  'player/singleReplayView.ts',
  'player/difficultyPicker.ts',
  'player/uiSounds.ts',
  'player/notifications.ts',
  'player/i18n.ts',
  'results/panel.ts',
  'results/icons.ts',
  'results/reveal.ts',
  'results/accuracyCircle.ts',
  'results/accuracyGauge.ts',
  'results/animate.ts',
  'results/theme.ts',
];

// Clean app-specific target directories in site/
await fs.rm(path.join(SITE_DIR, 'player'), { recursive: true, force: true });
await fs.rm(path.join(SITE_DIR, 'results'), { recursive: true, force: true });
await fs.rm(path.join(SITE_DIR, 'app'), { recursive: true, force: true });
await fs.rm(path.join(SITE_DIR, 'replay'), { recursive: true, force: true });
await fs.mkdir(path.join(SITE_DIR, 'app'), { recursive: true });
await fs.mkdir(path.join(SITE_DIR, 'replay'), { recursive: true });

// `splitting` is not optional here: gives every entry the same manager instance for uiSounds.
await esbuild.build({
  entryPoints: ENTRIES.map(e => path.join(APP_DIR, e)),
  outdir: SITE_DIR,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  minify: true,
});

// Read source HTML
let primaryHtml = '';
try {
  primaryHtml = await fs.readFile(path.join(APP_DIR, 'index.html'), 'utf8');
} catch {
  primaryHtml = await fs.readFile(path.join(APP_DIR, 'dev.html'), 'utf8');
}

// 1. Root default homepage (/)
await fs.writeFile(path.join(SITE_DIR, 'index.html'), primaryHtml);

// 2. /replay and /replay/
await fs.writeFile(path.join(SITE_DIR, 'replay.html'), primaryHtml);
await fs.writeFile(path.join(SITE_DIR, 'replay', 'index.html'), primaryHtml);

// 3. /app/dev.html and /app/index.html (backwards compatibility)
await fs.writeFile(path.join(SITE_DIR, 'app', 'dev.html'), primaryHtml);
await fs.writeFile(path.join(SITE_DIR, 'app', 'index.html'), primaryHtml);

// 4. /preview.html and /app/preview.html
try {
  const previewHtml = await fs.readFile(path.join(APP_DIR, 'preview.html'), 'utf8');
  await fs.writeFile(path.join(SITE_DIR, 'preview.html'), previewHtml);
  await fs.writeFile(path.join(SITE_DIR, 'app', 'preview.html'), previewHtml);
} catch {
  // Preview is optional
}

// Fonts are optional and gitignored; copy them when the developer supplied them.
const fontsFrom = path.join(APP_DIR, 'fonts');
try {
  const names = await fs.readdir(fontsFrom);
  if (names.length > 0) {
    await fs.mkdir(path.join(SITE_DIR, 'fonts'), { recursive: true });
    await fs.mkdir(path.join(SITE_DIR, 'app', 'fonts'), { recursive: true });
    for (const name of names) {
      await fs.copyFile(path.join(fontsFrom, name), path.join(SITE_DIR, 'fonts', name));
      await fs.copyFile(path.join(fontsFrom, name), path.join(SITE_DIR, 'app', 'fonts', name));
    }
    console.log(`copied ${names.length} font file(s)`);
  }
} catch {
  console.log('app/fonts/ absent — the pages fall back to Quicksand');
}

const assetPairs = [
  [path.join('assets', 'skin'), path.join(SITE_DIR, 'assets', 'skin')],
  [path.join('assets', 'lazer-defaults'), path.join(SITE_DIR, 'assets', 'lazer-defaults')],
  [path.join('assets', 'ui-sounds'), path.join(SITE_DIR, 'assets', 'ui-sounds')],
  [path.join('assets', 'skin'), path.join(SITE_DIR, 'app', 'assets', 'skin')],
  [path.join('assets', 'lazer-defaults'), path.join(SITE_DIR, 'app', 'assets', 'lazer-defaults')],
  [path.join('assets', 'ui-sounds'), path.join(SITE_DIR, 'app', 'assets', 'ui-sounds')],
  [path.join('assets', 'skin'), path.join(APP_DIR, 'assets', 'skin')],
  [path.join('assets', 'lazer-defaults'), path.join(APP_DIR, 'assets', 'lazer-defaults')],
  [path.join('assets', 'ui-sounds'), path.join(APP_DIR, 'assets', 'ui-sounds')],
];

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

await fs.rm(path.join(SITE_DIR, 'assets'), { recursive: true, force: true });
for (const [from, to] of assetPairs) {
  await fs.cp(from, to, { recursive: true });
}

console.log('built modern replay viewer into site/ (default /, /replay, /preview, and /app/dev)');
