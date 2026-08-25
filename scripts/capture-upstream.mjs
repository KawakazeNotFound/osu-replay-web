import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const site = path.join(root, 'site');
const base = process.env.REPLAYVIEWER_UPSTREAM ?? 'https://www.replayviewer.com';
const concurrency = 12;

// Upstream's own proxy is one person's deployment; we route these calls at our own
// Worker instead (see worker/index.js). Everything else upstream depends on —
// osu.direct / Nerinyan mirrors, Google Fonts, flagcdn — is shared infrastructure
// that ppy itself leans on, so it stays.
const UPSTREAM_PROXY = 'https://proxy.replayviewer.com/osu-proxy';
const OWN_PROXY = '/osu-proxy';

// Upstream's engine ignores storyboards, so its Nerinyan mirror URL strips them to save
// bandwidth. Ours draws them, so the .osb and its sprite images have to arrive — drop the
// flag. (Its other mirror, osu.direct, only passes noVideo=1 and already ships the .osb.)
const MIRROR_FLAG_REMOVALS = ['&noStoryboard=1', 'noStoryboard=1&', '?noStoryboard=1'];

async function fetchBytes(relativePath) {
  const url = new URL(relativePath, `${base}/`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// URL paths arrive percent-encoded (skin names contain spaces, filenames contain '@').
// The asset server matches requests against decoded paths, so the bytes must land under
// the decoded name — writing 'Skin%20for%20CTB/' verbatim serves 404s for 'Skin for CTB/'.
function decodePath(pathname) {
  return pathname.split('/').map(segment => decodeURIComponent(segment)).join('/');
}

async function writeAsset(relativePath, bytes) {
  const normalized = relativePath.replace(/^\/+|\/+$/g, '');
  const outputPath = normalized === ''
    ? 'index.html'
    : relativePath.endsWith('/')
      ? path.join(normalized, 'index.html')
      : normalized;
  const destination = path.join(site, decodePath(outputPath).replaceAll('/', path.sep));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
}

async function capture(relativePath) {
  const bytes = await fetchBytes(relativePath);
  await writeAsset(relativePath, bytes);
  return bytes;
}

function extractRootAssets(html) {
  const assets = new Set();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const value = match[1];
    if (/^[A-Za-z0-9._-]+\.(?:js|css|map|png)$/i.test(value)) assets.add(value);
  }
  return [...assets];
}

function extractWorkerAssets(html) {
  const match = html.match(/window\.__WORKER_JS__\s*=\s*(\{.*?\})\s*;/s);
  if (match === null) return [];
  const manifest = JSON.parse(match[1]);
  return Object.values(manifest).filter(value => typeof value === 'string');
}

/**
 * Relative specifiers a JS module pulls in — static `import`/`export ... from`, dynamic
 * `import()`, and its sourceMappingURL. The upstream app bundle is code-split, so
 * index.html mentions only `app-*.js` while that file imports chunk-*.js siblings which
 * in turn import each other; capturing only what the HTML references leaves the module
 * graph broken (and `not_found_handling` would serve index.html for the gaps, which the
 * browser rejects as a text/html module script).
 */
function extractJsDeps(js) {
  const deps = new Set();
  const patterns = [
    /(?:^|[\s;}])(?:import|export)[^'"]*?from\s*['"](\.\/[^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"](\.\/[^'"]+)['"]/g,
    /import\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of js.matchAll(pattern)) deps.add(match[1].replace(/^\.\//, ''));
  }
  const map = /sourceMappingURL=([^\s*'"]+)/.exec(js);
  if (map !== null && !map[1].startsWith('data:')) deps.add(map[1].replace(/^\.\//, ''));
  return [...deps];
}

/** Captures a JS asset and everything it imports, transitively. */
async function captureJsGraph(entry, seen = new Set()) {
  const queue = [entry];
  while (queue.length > 0) {
    const asset = queue.shift();
    if (seen.has(asset)) continue;
    seen.add(asset);
    const bytes = await capture(`/${asset}`);
    if (!asset.endsWith('.js')) continue;
    for (const dep of extractJsDeps(bytes.toString('utf8'))) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

function extractSkinNames(app) {
  const match = app.match(/DEFAULT_SKINS\s*=\s*\[([\s\S]*?)\]/);
  if (match === null) {
    return ['YUGEN', 'Default', 'Rafis', 'bog', 'Kamui', 'UNTITLED',
      'shinchikuskin', '4sbet1', 'R Skin V2.0', 'bojii', 'myuka arrows', 'Skin for CTB'];
  }
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map(matchItem => matchItem[1]);
}

function encodePath(pathname) {
  return pathname.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

async function captureSkin(name) {
  const prefix = `skins/${encodeURIComponent(name)}`;
  const manifestPath = `${prefix}/index.json`;
  const manifestBytes = await capture(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const files = manifest.files ?? [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor++];
      const sourcePath = `${prefix}/${encodePath(file)}`;
      await capture(sourcePath);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  console.log(`captured skin ${name}: ${files.length} files`);
}

/** Percent-encoded leftovers from before decodePath() existed — they shadow nothing, just waste bytes. */
async function removeEncodedLeftovers(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.name.includes('%')) {
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } else if (entry.isDirectory()) {
      removed += await removeEncodedLeftovers(full);
    }
  }
  return removed;
}

/**
 * Post-capture rewrite: point the app at our own Worker and strip upstream's telemetry
 * (the beacon token belongs to upstream's account, so leaving it in ships our traffic to
 * someone else's dashboard). Scans every captured JS file — the proxy URL lives in the
 * app bundle today, but code-splitting could move it into a chunk.
 */
async function rewriteCapturedAssets(jsAssets) {
  let total = 0;
  let storyboardFlagsDropped = 0;
  for (const asset of jsAssets) {
    const assetPath = path.join(site, asset);
    const text = await fs.readFile(assetPath, 'utf8').catch(() => null);
    if (text === null) continue;
    let next = text;
    const occurrences = next.split(UPSTREAM_PROXY).length - 1;
    if (occurrences > 0) next = next.split(UPSTREAM_PROXY).join(OWN_PROXY);
    for (const flag of MIRROR_FLAG_REMOVALS) {
      const hits = next.split(flag).length - 1;
      if (hits === 0) continue;
      // Ordered longest-context-first in MIRROR_FLAG_REMOVALS so removing the whole match
      // leaves a well-formed query string (`?noVideo=1&noStoryboard=1` → `?noVideo=1`).
      next = next.split(flag).join('');
      storyboardFlagsDropped += hits;
    }
    if (next === text) continue;
    await fs.writeFile(assetPath, next);
    if (occurrences > 0) {
      console.log(`rewrote ${occurrences} proxy reference(s) in ${asset} -> ${OWN_PROXY}`);
      total += occurrences;
    }
  }
  if (storyboardFlagsDropped > 0) {
    console.log(`dropped ${storyboardFlagsDropped} noStoryboard flag(s) so mirrors ship the .osb`);
  }
  if (total === 0) {
    throw new Error(
      `rewrite: '${UPSTREAM_PROXY}' not found in any captured JS — upstream changed its proxy `
      + 'URL, update UPSTREAM_PROXY before deploying or the app will talk to the wrong host',
    );
  }

  // String.replace resets a global regex's lastIndex; .test() would not, and would
  // silently skip the second page.
  const beacon = /<!-- Cloudflare Pages Analytics -->.*?<!-- Cloudflare Pages Analytics -->/gs;
  for (const page of ['index.html', path.join('auth', 'osu', 'index.html')]) {
    const pagePath = path.join(site, page);
    const html = await fs.readFile(pagePath, 'utf8');
    const stripped = html.replace(beacon, '');
    if (stripped === html) continue;
    await fs.writeFile(pagePath, stripped);
    console.log(`stripped upstream analytics beacon from ${page}`);
  }
}

/**
 * Replaces upstream's compiled engine chunk with a build of our own src/.
 *
 * The captured app imports 21 named symbols from a hash-named chunk that is upstream's
 * build of this same engine. Leaving it in place means nothing we implement in src/ ever
 * reaches the deployed page. The chunk is shared by app-*.js and export-worker-*.js, so
 * one swap covers playback and video export.
 *
 * Fails loudly when the app needs a symbol our engine does not export — better a broken
 * build than a page that dies at module-eval with an opaque import error.
 */
/**
 * The engine's hitsound cascade falls back to osu!'s 12 default wavs, fetched from
 * `skins/lazer-defaults/` relative to the page (see loadLazerDefaultSounds). Upstream
 * serves them but they are not reachable from index.html or the DEFAULT_SKINS list, so
 * capture never saw them and every lookup 404'd — silently degrading playback to the
 * synthesized click. This repo already ships the same files, so copy them in rather than
 * asking upstream for 12 more requests.
 */
async function copyLazerDefaults() {
  const from = path.join(root, 'assets', 'lazer-defaults');
  const to = path.join(site, 'skins', 'lazer-defaults');
  let names;
  try {
    names = (await fs.readdir(from)).filter(name => name.endsWith('.wav'));
  } catch {
    console.warn('WARNING: assets/lazer-defaults/ is missing — fallback hitsounds will 404 '
      + 'and playback degrades to synthesized clicks');
    return;
  }
  await fs.mkdir(to, { recursive: true });
  for (const name of names) {
    await fs.copyFile(path.join(from, name), path.join(to, name));
  }
  console.log(`copied ${names.length} lazer default hitsound(s) to skins/lazer-defaults/`);
}

async function swapEngineChunk(appAsset) {
  const app = await fs.readFile(path.join(site, appAsset), 'utf8');
  const match = /import\s*\{([\s\S]*?)\}\s*from\s*["'](?:\.\/)?(chunk-[A-Za-z0-9]+\.js)["']/.exec(app);
  if (match === null) {
    throw new Error(
      `swap: no named chunk import found in ${appAsset} — upstream changed its bundling, `
      + 'so the engine chunk can no longer be identified',
    );
  }
  const [, symbolList, chunkName] = match;
  const required = symbolList
    .split(',')
    .map(entry => entry.trim().split(/\s+as\s+/)[0])
    .filter(entry => entry !== '');

  const outfile = path.join(site, chunkName);
  await esbuild.build({
    entryPoints: [path.join(root, 'site-engine', 'index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    target: 'es2020',
    sourcemap: true,
    allowOverwrite: true,
  });

  const built = await fs.readFile(outfile, 'utf8');
  const exportBlocks = [...built.matchAll(/export\s*\{([\s\S]*?)\}\s*;/g)];
  const exported = new Set(
    exportBlocks.flatMap(block => block[1].split(',').map(entry => {
      const parts = entry.trim().split(/\s+as\s+/);
      return (parts[1] ?? parts[0]).trim();
    })),
  );
  const missing = required.filter(symbol => !exported.has(symbol));
  if (missing.length > 0) {
    throw new Error(
      `swap: our engine does not export ${missing.join(', ')} — the app imports them from `
      + `${chunkName}. Add them to site-engine/index.ts (see the pp-counter shims there).`,
    );
  }

  const bytes = (await fs.stat(outfile)).size;
  console.log(
    `swapped ${chunkName} for our own engine build (${Math.round(bytes / 1024)} KB, `
    + `${required.length}/${required.length} imports satisfied)`,
  );
}

/** End index of the element opening at `openIdx`, matching `<tag`/`</tag` by depth. */
function matchingClose(html, openIdx, tag) {
  const re = new RegExp(`<(/?)${tag}\\b`, 'g');
  re.lastIndex = openIdx;
  let depth = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.indexOf('>', m.index) + 1;
  }
  return -1;
}

/**
 * Collapses the left panel's credits block into a disclosure and lists what this build adds
 * on top of upstream.
 *
 * The "not affiliated with osu!/ppy" line stays *outside* the disclosure on purpose: a
 * disclaimer that exists to prevent confusion is the one thing that should not be a click
 * away. Attribution (author, danser/osu!/mirror credits, issue links) moves inside — still
 * in the DOM and one click off, which keeps the MIT notice retained.
 *
 * Styles are injected into index.html rather than the hashed stylesheet, so an upstream CSS
 * rebuild cannot silently drop them.
 */
async function addCreditsDisclosure() {
  const pagePath = path.join(site, 'index.html');
  const text = await fs.readFile(pagePath, 'utf8');

  const bodyOpen = text.indexOf('<div class="info-body">');
  if (bodyOpen === -1) {
    throw new Error('credits: <div class="info-body"> not found — upstream restructured the '
      + 'left panel; update addCreditsDisclosure before deploying');
  }
  const bodyClose = matchingClose(text, bodyOpen, 'div');
  if (bodyClose === -1) throw new Error('credits: info-body has no matching close tag');

  const openTagEnd = text.indexOf('>', bodyOpen) + 1;
  let inner = text.slice(openTagEnd, bodyClose - '</div>'.length);

  // Lift the disclaimer out so it stays visible.
  const disclaimerStart = inner.indexOf('<p class="info-unsupported">');
  if (disclaimerStart === -1) {
    throw new Error('credits: info-unsupported paragraph not found — it must stay visible, so '
      + 'the transform refuses to guess');
  }
  const disclaimerEnd = matchingClose(inner, disclaimerStart, 'p');
  const disclaimer = inner.slice(disclaimerStart, disclaimerEnd);
  inner = inner.slice(0, disclaimerStart) + inner.slice(disclaimerEnd);

  const added = `
              <p class="info-added-label">added in this build:</p>
              <ul class="info-added">
                <li>storyboards — sprites, animations and sound samples</li>
                <li>self-hosted: own osu! OAuth app and API proxy, no third-party relay</li>
                <li>runs its own build of the replay engine</li>
                <li>not included: storyboard video, triggers, or storyboards in video export</li>
              </ul>`;

  const replacement = `<div class="info-body">
              ${disclaimer.trim()}
              <details class="info-disclosure">
                <summary class="info-disclosure-summary">about &amp; credits</summary>
                <div class="info-disclosure-body">${inner}${added}
                </div>
              </details>
            </div>`;

  const styles = `
    <style>
      /* Injected by scripts/capture-upstream.mjs — see addCreditsDisclosure. */
      .info-disclosure { border-top: 1px solid #2a2a4a; padding-top: 0.5rem; }
      .info-disclosure-summary {
        cursor: pointer; list-style: none; color: #e879a0; font-size: 0.75rem;
        font-weight: 600; display: flex; align-items: center; gap: 0.35rem;
      }
      .info-disclosure-summary::-webkit-details-marker { display: none; }
      .info-disclosure-summary::before {
        content: "▸"; font-size: 0.7rem; transition: transform 0.15s ease;
      }
      .info-disclosure[open] .info-disclosure-summary::before { transform: rotate(90deg); }
      .info-disclosure-body {
        display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.55rem;
      }
      .info-added-label { color: #e879a0; font-weight: 600; font-size: 0.75rem; }
      .info-added {
        list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
        gap: 0.15rem; color: #a0a0b0; font-size: 0.75rem;
      }
      .info-added li { position: relative; padding-left: 0.8rem; }
      .info-added li::before { content: "+"; position: absolute; left: 0.1rem; color: #e879a0; }
    </style>`;

  let next = text.slice(0, bodyOpen) + replacement + text.slice(bodyClose);
  next = next.replace('</head>', `${styles}\n  </head>`);
  await fs.writeFile(pagePath, next);
  console.log('wrapped credits in a disclosure and listed this build\'s additions');
}

/**
 * Upstream's captured oauth-config.json carries THEIR client_id, which cannot work from
 * our origin (osu! validates redirect_uri per registered app). Overwrite it with ours.
 *
 * Single source of truth is wrangler.jsonc's vars.OSU_CLIENT_ID — the same value the
 * Worker pins server-side, so the frontend and the token exchange can't drift apart.
 * Read by regex rather than JSON.parse because the file is JSONC (comments).
 */
async function writeOauthConfig() {
  let clientId = process.env.OSU_CLIENT_ID ?? null;
  if (clientId === null) {
    const wrangler = await fs.readFile(path.join(root, 'wrangler.jsonc'), 'utf8').catch(() => '');
    clientId = /"OSU_CLIENT_ID"\s*:\s*"([^"]*)"/.exec(wrangler)?.[1] ?? null;
  }
  const configPath = path.join(site, 'oauth-config.json');
  if (clientId === null || clientId === '') {
    console.warn(
      'WARNING: no client id found (OSU_CLIENT_ID env var or wrangler.jsonc vars.OSU_CLIENT_ID) — '
      + "site/oauth-config.json still holds upstream's client_id, so osu! login WILL fail "
      + '(redirect_uri mismatch). Register an OAuth app at '
      + 'https://osu.ppy.sh/home/account/edit#oauth and re-run.',
    );
    return;
  }
  await fs.writeFile(configPath, `${JSON.stringify({ client_id: String(clientId) })}\n`);
  console.log(`wrote site/oauth-config.json with client_id ${clientId}`);
}

await fs.mkdir(site, { recursive: true });
// Remove the previous Minimal example output so the Workers asset bundle only
// contains the upstream viewer and its captured runtime assets.
await fs.rm(path.join(site, 'main.js'), { force: true });
await fs.rm(path.join(site, 'dist'), { recursive: true, force: true });
await fs.rm(path.join(site, 'assets'), { recursive: true, force: true });
const leftovers = await removeEncodedLeftovers(site);
if (leftovers > 0) console.log(`removed ${leftovers} percent-encoded leftover path(s)`);

const htmlBytes = await capture('/');
const html = htmlBytes.toString('utf8');
const rootAssets = extractRootAssets(html);
const workerAssets = extractWorkerAssets(html);

// Follow each JS entry's import graph — code-split chunks are reachable only this way.
const captured = new Set();
for (const asset of [...new Set([...rootAssets, ...workerAssets])]) {
  await captureJsGraph(asset, captured);
}
const chunks = [...captured].filter(a => /^chunk-/.test(a) && a.endsWith('.js'));
console.log(`captured ${captured.size} root asset(s), including ${chunks.length} code-split chunk(s)`);

await capture('/oauth-config.json');
await capture('/auth/osu/');

const appAsset = rootAssets.find(asset => /^app-.*\.js$/i.test(asset));
if (appAsset === undefined) throw new Error('upstream app bundle was not found in index.html');
const app = (await fs.readFile(path.join(site, appAsset))).toString('utf8');
const skinNames = extractSkinNames(app);
for (const skin of skinNames) await captureSkin(skin);

await rewriteCapturedAssets([...captured].filter(a => a.endsWith('.js')));
await copyLazerDefaults();
await addCreditsDisclosure();
await swapEngineChunk(appAsset);
await writeOauthConfig();

console.log(`captured replayviewer upstream into ${path.relative(root, site)}/`);
