// Test runner: bundles each test/*.test.ts with esbuild and runs it.
//
// No test framework — `node:test` is built in, so this adds no dependencies, matching the
// repo's esbuild+tsc-only toolchain. Tests live outside src/ so they stay out of the
// published declaration tree.
//
// The tests are NOT typechecked: doing so would need @types/node for the node:test and
// node:assert imports, and this repo carries no @types at all. esbuild strips the
// annotations without checking them, so a type error in a test surfaces as a failing
// assertion rather than a compile error. `npm run build` still typechecks all of src/,
// which is where the shipped code lives.
//
// Run: `npm test`

import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// app/ IS typechecked (it is DOM-only, so needs no @types/node). This runs first because a
// NaN score once reached a screenshot purely because the preview page is untypechecked JS.
execFileSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.app.json'],
  { stdio: 'inherit' },
);

const TEST_DIR = 'test';
const OUT_DIR = path.join('node_modules', '.cache', 'replayviewer-tests');

const entries = (await fs.readdir(TEST_DIR))
  .filter(name => name.endsWith('.test.ts'))
  .map(name => path.join(TEST_DIR, name));

if (entries.length === 0) {
  console.log('test: no test/*.test.ts files found');
  process.exit(0);
}

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

await esbuild.build({
  entryPoints: entries,
  outdir: OUT_DIR,
  bundle: true,
  format: 'esm',
  platform: 'node',
  // A node target, not a JS one: with a plain `es*` target esbuild assumes the runtime may
  // not understand `node:` prefixes and strips them, so `node:test` becomes a bare `test`
  // import that fails to resolve.
  target: 'node20',
  // npm deps are bundled rather than left external. `platform: 'node'` already keeps the
  // builtins out, which is all that ever needed to stay external; leaving *everything* external
  // meant a test could not import anything that reached a CommonJS dependency — importing
  // app/player/match.ts died on `Named export 'LZMA' not found` from lzma, two layers down
  // through the engine, which has nothing to do with the test.
  sourcemap: 'inline',
});

let failed = 0;
for (const entry of entries) {
  const bundled = path.join(OUT_DIR, path.basename(entry).replace(/\.ts$/, '.js'));
  try {
    execFileSync(process.execPath, [bundled], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}

if (failed > 0) {
  console.error(`test: ${failed} of ${entries.length} test file(s) failed`);
  process.exit(1);
}
console.log(`test: ${entries.length} test file(s) passed`);
