// The pruner deletes files from a deployed site, so what it decides to keep matters more than what
// it deletes. These fixtures cover the three ways a chunk stays reachable and the one shape that
// makes it garbage — and in particular that the captured upstream page, which uses the same
// `chunk-<HASH>.js` naming as our own build, survives a prune it did not run.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { analyseSite, danglingReferences, pruneSite } from '../scripts/prune-site.mjs';

/** Writes a throwaway site/ tree from `{ relativePath: contents }` and returns its directory. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prune-site-'));
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return dir;
}

test('a chunk reached through an entry module is kept, an orphan is not', async () => {
  const dir = await fixture({
    'index.html': '<script type="module" src="/player/load.js"></script>',
    'player/load.js': 'import"../chunk-AAAAAAAA.js";',
    'chunk-AAAAAAAA.js': 'export const a=1;',
    'chunk-BBBBBBBB.js': 'export const b=2;',
  });

  const { total, kept, dead } = await analyseSite(dir);
  assert.equal(total, 2);
  assert.equal(kept, 1);
  assert.deepEqual(dead, ['chunk-BBBBBBBB.js']);
});

test('reachability is transitive — a chunk imported only by another chunk survives', async () => {
  const dir = await fixture({
    'index.html': '<script type="module" src="/player/load.js"></script>',
    'player/load.js': 'import"../chunk-AAAAAAAA.js";',
    'chunk-AAAAAAAA.js': 'import"./chunk-CCCCCCCC.js";',
    'chunk-CCCCCCCC.js': 'export const c=3;',
    'chunk-BBBBBBBB.js': 'export const b=2;',
  });

  assert.deepEqual((await analyseSite(dir)).dead, ['chunk-BBBBBBBB.js']);
});

test('a name mentioned as a bare string is enough — worker URLs are not imports', async () => {
  const dir = await fixture({
    'index.html': '<script type="module" src="/player/load.js"></script>',
    // configureWorkers is handed a URL, not an import specifier.
    'player/load.js': 'configureWorkers({stretch:"/stretch-worker-ZZZZZZZZ.js"});',
    'stretch-worker-ZZZZZZZZ.js': 'onmessage=()=>{};',
  });

  assert.deepEqual((await analyseSite(dir)).dead, [], 'a referenced worker must not be pruned');
});

test('the captured upstream page survives a prune run by the app build', async () => {
  // Its entry and chunks are named exactly like ours, and only /legacy points at them.
  const dir = await fixture({
    'index.html': '<script type="module" src="/player/load.js"></script>',
    'player/load.js': 'import"../chunk-AAAAAAAA.js";',
    'chunk-AAAAAAAA.js': 'export const a=1;',
    'legacy/index.html': '<script type="module" src="/app-K2327MOW.js"></script>',
    'app-K2327MOW.js': 'import"./chunk-UPUPUPUP.js";',
    'chunk-UPUPUPUP.js': 'export const up=1;',
    'chunk-BBBBBBBB.js': 'export const b=2;',
  });

  const { dead } = await analyseSite(dir);
  assert.deepEqual(dead, ['chunk-BBBBBBBB.js']);
  assert.ok(!dead.includes('app-K2327MOW.js'), "the captured page's entry is not a candidate loss");
});

test('stable names are never candidates, however unreferenced they look', async () => {
  const dir = await fixture({
    'index.html': '<p>no scripts at all</p>',
    'player/load.js': 'export const load=1;',
    'chunk-BBBBBBBB.js': 'export const b=2;',
  });

  const { total, dead } = await analyseSite(dir);
  assert.equal(total, 1, 'only the hashed file is ever considered');
  assert.deepEqual(dead, ['chunk-BBBBBBBB.js']);
});

test('pruning removes the dead chunk and its sourcemap, and nothing else', async () => {
  const dir = await fixture({
    'index.html': '<script type="module" src="/player/load.js"></script>',
    'player/load.js': 'import"../chunk-AAAAAAAA.js";',
    'chunk-AAAAAAAA.js': 'export const a=1;',
    'chunk-AAAAAAAA.js.map': '{"sources":["../app/a.ts"]}',
    'chunk-BBBBBBBB.js': 'export const b=2;',
    'chunk-BBBBBBBB.js.map': '{"sources":["../app/b.ts"]}',
  });

  const { dead } = await pruneSite({ siteDir: dir });
  assert.deepEqual(dead, ['chunk-BBBBBBBB.js']);

  const left = (await fs.readdir(dir)).sort();
  assert.deepEqual(left, ['chunk-AAAAAAAA.js', 'chunk-AAAAAAAA.js.map', 'index.html', 'player']);
});

test('a dry run reports without touching the tree', async () => {
  const dir = await fixture({
    'index.html': '<p>nothing</p>',
    'chunk-BBBBBBBB.js': 'export const b=2;',
  });

  const { dead } = await pruneSite({ siteDir: dir, dryRun: true });
  assert.deepEqual(dead, ['chunk-BBBBBBBB.js']);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['chunk-BBBBBBBB.js', 'index.html']);
});

test('a longer name is not read as a reference to its own tail', async () => {
  // `export-worker-3VEUX4SI.js` contains `worker-3VEUX4SI.js`. A bare substring search reports
  // that shorter name as a broken reference and fails a build that is perfectly fine.
  const dir = await fixture({
    'legacy/index.html': '<script type="module" src="/export-worker-3VEUX4SI.js"></script>',
    'export-worker-3VEUX4SI.js': 'onmessage=()=>{};',
  });

  assert.equal((await danglingReferences(dir)).size, 0);
});

test('a genuinely missing file is reported against the pages that want it', async () => {
  const dir = await fixture({
    'index.html': '<script type="module" src="/chunk-MISSINGX.js"></script>',
  });

  const dangling = await danglingReferences(dir);
  assert.deepEqual([...dangling.keys()], ['chunk-MISSINGX.js']);
  assert.deepEqual(dangling.get('chunk-MISSINGX.js'), ['index.html']);
});

test('a prune that would break the site fails loudly instead', async () => {
  // A page naming a chunk in a way the reachability scan cannot see would delete it. Simulated
  // here by pointing the check at a tree that is already inconsistent.
  const dir = await fixture({
    'index.html': '<p>nothing references anything</p>',
    'chunk-AAAAAAAA.js': 'import"./chunk-BBBBBBBB.js";',
  });
  // chunk-AAAAAAAA is unreachable and goes; it was the only thing naming chunk-BBBBBBBB, which
  // does not exist — so nothing dangles and the prune succeeds.
  await pruneSite({ siteDir: dir });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['index.html']);

  const broken = await fixture({
    'index.html': '<script src="/chunk-CCCCCCCC.js"></script>',
  });
  await assert.rejects(
    pruneSite({ siteDir: broken }),
    /still references/,
    'a tree missing a file its page names must not be reported as a clean prune',
  );
});
