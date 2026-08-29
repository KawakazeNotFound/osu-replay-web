# rosu-pp, browser build

`rosu-pp` ([MaxOhn/rosu-pp-js](https://github.com/MaxOhn/rosu-pp-js)) compiled to WebAssembly,
used by `app/player/performance.ts` to compute star rating and pp locally — for the plays osu!
has no score record of, which is every Auto replay, every unsubmitted play, and every map that
was never uploaded.

**Version: v4.0.1**, artifact `rosu_pp_js_web.tar.gz` from
<https://github.com/MaxOhn/rosu-pp-js/releases/tag/v4.0.1>. MIT, see `LICENSE`.

## Why this is vendored rather than installed

The npm package `rosu-pp-js` ships the **Node** build: it `require`s `fs`/`path`/`util` and reads
`rosu_pp_js_bg.wasm` off disk synchronously, so it cannot run in a browser at all. The browser
build is a separate release artifact and is not published to npm, so it lives here.

`rosu-pp-js` is still a devDependency — `test/performance-args.test.ts` runs the real calculator in
Node, where being Node-only is exactly what is wanted. Both must be the same version; bump them
together.

## Why not in `src/`

`scripts/build.mjs` requires `dist/index.js` to be self-contained — no residual bare-specifier
imports. A wasm-bindgen module cannot satisfy that: the `.wasm` is a separate binary, so the bundle
would either keep an import (the guard fails the build) or base64-inline ~800 KB into every consumer
of the published library. `app/` has no such constraint, and `site/` already serves binary assets.

## How it is wired

`build-app.mjs` copies `rosu_pp_js_bg.wasm` to `site/rosu-pp/`, and `performance.ts` hands that
absolute URL to the wasm-bindgen init. esbuild only ever sees `rosu_pp_js.js`, which it splits into
its own chunk behind a dynamic `import()` — so neither the glue nor the binary is fetched until a
figure is actually asked for.

## Updating

1. Download the new `rosu_pp_js_web.tar.gz` from the releases page and replace every file here
   except this README.
2. Bump `rosu-pp-js` in `package.json` to the same version.
3. Run `npm test` — the end-to-end cases catch renamed or removed argument fields.
4. Note that pp values move when osu! reworks its algorithms; the panel labels computed figures
   `CALCULATED` for exactly that reason.
