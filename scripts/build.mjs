// Library build: emits dist/ from src/ alone.
//   index.js           self-contained ESM bundle of src/index.ts (npm deps inlined)
//   stretch-worker.js  module-worker bundle of stretchWorker.ts — consumers pass its
//                      URL to configureWorkers({ stretch: ... }) to enable off-thread
//                      DT/HT stretching (omitting it falls back to the sync path)
//   **/*.d.ts          tsc declaration tree; dist/index.d.ts types the bundle
//
// Run: `npm run build`

import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { checkImports } from './check-imports.mjs';

const OUT_DIR = 'dist';

const violations = await checkImports();
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

await fs.rm(OUT_DIR, { recursive: true, force: true });

execFileSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  { stdio: 'inherit' },
);

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
};
await esbuild.build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: `${OUT_DIR}/index.js`,
});
await esbuild.build({
  ...common,
  entryPoints: ['src/player/stretchWorker.ts'],
  outfile: `${OUT_DIR}/stretch-worker.js`,
});

// The bundles must be self-contained: no residual imports of bare specifiers
// (esbuild inlines all deps when nothing is marked external — this guards regressions).
for (const file of ['index.js', 'stretch-worker.js']) {
  const text = await fs.readFile(`${OUT_DIR}/${file}`, 'utf8');
  const bare = [...text.matchAll(/^import[^'"]*['"]([^'".][^'"]*)['"]/gm)]
    .map(m => m[1]);
  if (bare.length > 0) {
    console.error(`build: ${file} is not self-contained — imports ${bare.join(', ')}`);
    process.exit(1);
  }
}

console.log(`built ${OUT_DIR}/index.js + stretch-worker.js + d.ts tree`);
