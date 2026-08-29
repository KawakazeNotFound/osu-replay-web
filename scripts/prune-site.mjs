// Deletes content-hashed JS in site/ that nothing references any more.
//
// Two builds write into site/ and both name their output `chunk-<HASH>.js`: `capture:upstream`
// brings down the captured page (its `app-*.js`, `export-worker-*.js`, `stretch-worker-*.js` and
// their chunk siblings, still served at /legacy) and `build-app.mjs` emits the modern UI. Because
// the names carry a content hash, every rebuild writes new files and leaves the old ones behind —
// 106 dead chunks had piled up before this existed, all of them deployed on every `wrangler
// deploy`. Neither build can clean up with a pattern sweep, because `chunk-*.js` does not say who
// wrote it, and `rm site/chunk-*.js` takes the captured page's engine with it.
//
// Reachability decides instead, which needs no bookkeeping and is safe for both builds: a
// content-hashed file that nothing mentions is unreachable by construction — nothing can ask for
// it, because its name is the only way to and that name appears nowhere.
//
// Deliberately conservative. A candidate survives if its name occurs *anywhere* in any reachable
// file, not just in an import statement, so a worker URL built as a bare string ("stretch-worker-
// ZOWVX5BS.js") keeps its file. Over-keeping leaves a dead file; over-deleting breaks the site.
//
// Run: `node scripts/prune-site.mjs [--dry-run]`, and automatically at the end of build-app.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SITE_DIR = 'site';

/**
 * Output names esbuild and the captured page both use: a basename, a dash, and an 8-character
 * content hash. Only these are ever deletion candidates — a stable name like `player/load.js` is
 * an entry point, and deleting it would break the page even though nothing "references" it by
 * name.
 */
const HASHED = /^[A-Za-z0-9_]+-[A-Z0-9]{8}\.js$/;

/** Every file under `dir`, recursively, as paths relative to it. */
async function filesUnder(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(dir, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Which hashed files are unreachable, and which are kept.
 *
 * Seeds are everything whose name is not itself a hash — the HTML pages and the stable-named entry
 * modules — because those are what a browser can reach without being told a hash. Reachability
 * then spreads through the candidates a seed mentions, to a fixpoint.
 */
export async function analyseSite(siteDir = SITE_DIR) {
  const all = await filesUnder(siteDir);

  const candidates = new Map();
  const seeds = [];
  for (const rel of all) {
    const name = path.basename(rel);
    if (rel.endsWith('.js') && HASHED.test(name)) {
      // A hash is unique to its content, so two directories cannot disagree about a name.
      candidates.set(name, rel);
    } else if (rel.endsWith('.html') || rel.endsWith('.js')) {
      seeds.push(rel);
    }
  }

  const reachable = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const rel = queue.pop();
    let text;
    try {
      text = await fs.readFile(path.join(siteDir, rel), 'utf8');
    } catch {
      continue;
    }
    for (const [name, target] of candidates) {
      if (reachable.has(name)) continue;
      if (!text.includes(name)) continue;
      reachable.add(name);
      queue.push(target);
    }
  }

  const dead = [...candidates.entries()]
    .filter(([name]) => !reachable.has(name))
    .map(([, rel]) => rel)
    .sort();

  return { total: candidates.size, kept: reachable.size, dead };
}

/**
 * Deletes the unreachable hashed files and their sourcemaps. Returns what it removed.
 *
 * Sourcemaps are not candidates in their own right — nothing references a `.js.map` by name except
 * the `//# sourceMappingURL` comment in the file being deleted — so each one goes with its script.
 */
export async function pruneSite({ siteDir = SITE_DIR, dryRun = false } = {}) {
  const { total, kept, dead } = await analyseSite(siteDir);

  if (!dryRun) {
    for (const rel of dead) {
      await fs.rm(path.join(siteDir, rel), { force: true });
      await fs.rm(path.join(siteDir, `${rel}.map`), { force: true });
    }
  }

  return { total, kept, dead };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const { total, kept, dead } = await pruneSite({ dryRun });
  for (const rel of dead) console.log(`${dryRun ? 'would remove' : 'removed'} ${rel}`);
  console.log(
    `prune-site: ${total} hashed file(s), ${kept} reachable, `
    + `${dead.length} ${dryRun ? 'prunable' : 'pruned'}`,
  );
}
