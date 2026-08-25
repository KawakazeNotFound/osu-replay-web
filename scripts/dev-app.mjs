// Dev server for the app/ preview pages: serves app/ with the .ts modules compiled on the
// fly by esbuild, so the preview can import them the same way the built page will.
//
// Run: node scripts/dev-app.mjs   → http://127.0.0.1:8900/preview.html
import esbuild from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('app');
const PORT = 8900;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

/** A request for `x.js` is served by bundling `x.ts` when only the source exists. */
async function serveModule(tsPath, res) {
  try {
    const built = await esbuild.build({
      entryPoints: [tsPath],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      write: false,
      sourcemap: 'inline',
    });
    res.writeHead(200, { 'Content-Type': TYPES['.js'] });
    res.end(built.outputFiles[0].text);
  } catch (err) {
    // Surface build errors in the browser instead of a blank page.
    res.writeHead(500, { 'Content-Type': TYPES['.js'] });
    res.end(`console.error(${JSON.stringify(String(err))});`);
  }
}

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = url === '/' ? 'preview.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  if (file.endsWith('.js')) {
    const ts = `${file.slice(0, -3)}.ts`;
    if (fs.existsSync(ts)) { void serveModule(ts, res); return; }
  }

  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(`not found: ${rel}`);
}).listen(PORT, () => {
  console.log(`app dev server on http://127.0.0.1:${PORT}/preview.html`);
});
