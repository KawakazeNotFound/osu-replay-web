// Import-boundary checker: src/** may only import within src/. Bare npm
// specifiers are allowed (they're inlined into the bundle at build time).
// Runs standalone (`npm run check`) and inside scripts/build.mjs, where any
// violation fails the build.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'src';

// from '...' / import('...') / require('...') — static, dynamic and CJS import forms.
const SPEC_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

async function tsFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Returns a list of human-readable violation strings (empty = boundary holds). */
export async function checkImports() {
  const violations = [];
  for (const file of await tsFiles(SRC)) {
    const text = await fs.readFile(file, 'utf8');
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // bare specifier (npm dep)
      const resolved = path.normalize(path.join(path.dirname(file), spec));
      if (path.relative(SRC, resolved).startsWith('..')) {
        violations.push(`${file}: imports outside src/ ('${spec}')`);
      }
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = await checkImports();
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exit(1);
  }
  console.log('check-imports: boundary OK');
}
