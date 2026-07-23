# replayviewer

Render osu! replays in the browser. A TypeScript engine that parses `.osr`
replays, `.osu`/`.osz` beatmaps, and skins; re-judges the play from raw input
frames; and renders synchronized gameplay + audio onto a canvas.

- **All four rulesets** — osu!standard, taiko, catch, mania.
- **Stable and lazer replays**, with mod support: HD, HR/EZ, DT/HT/NC (real
  audio time-stretch, pitch-correct for DT/HT), FL, and more.
- **Headless analysis** — judge a replay and compute score/accuracy/combo/UR
  timelines with no canvas, skin, or audio (works in Node): stats sites, bots.
- **Auto replays** — synthesize a perfect play for any beatmap, no `.osr` needed.
- **Zero runtime dependencies** — `dist/index.js` is a single self-contained
  ES-module bundle.

This is the engine behind [replayviewer.com](https://replayviewer.com). The
code here is generated from an upstream source-of-truth repository, so please
file issues rather than pull requests against `src/`.

## Install

```sh
npm install replayviewer
```

The package ships `dist/index.js` (a single self-contained ES-module bundle),
`dist/stretch-worker.js`, and the full type-declaration tree — see
[Usage](#usage). Note that skins and other sample assets are not part of the
npm package; clone this repo to get them along with the runnable examples.

## Building from source

```sh
npm install
npm run build     # → dist/index.js + dist/stretch-worker.js + d.ts tree
```

Then try the examples (plain HTML pages + ES modules, no bundler — sample
replay/beatmap assets and a skin are included, so they run out of the box):

- [`examples/minimal/`](examples/minimal/) — load a replay + beatmap + skin
  and play it back.
- [`examples/dual/`](examples/dual/) — two replays of the same map side by
  side, clock-locked to one audio timeline.
- [`examples/embed/`](examples/embed/) — skip the library entirely and embed
  replayviewer.com in an iframe via postMessage.

## Dependencies

Everything is a `devDependency` — the three runtime libraries are bundled into
`dist/index.js`, so consumers install nothing else:

- `lzma` — decodes the LZMA-compressed input-frame stream inside `.osr` replays.
- `fflate` — unzips `.osz` beatmap sets and `.osk` skins.
- `@soundtouchjs/core` — pitch-correct audio time-stretching for DT/HT playback.
- `esbuild` — bundles `src/` into `dist/index.js` + `dist/stretch-worker.js`.
- `typescript` — type-checks and emits the `dist/` declaration tree.

## Usage

```js
import {
  configureWorkers, parseReplay, loadSkinFromDir, buildSkin, createReplaySession,
} from 'replayviewer';   // or './dist/index.js' when unbundled

// Optional: off-thread DT/HT time-stretching (falls back to a synchronous
// in-thread path when omitted).
configureWorkers({ stretch: '/path/to/dist/stretch-worker.js' });

const audioContext = new AudioContext();  // must be created inside a user gesture
const replay = await parseReplay(osrArrayBuffer);
const skin = await loadSkinFromDir('/skins/my-skin', audioContext);

const session = await createReplaySession({
  canvas,                 // HTMLCanvasElement
  audioContext,
  replay,
  beatmapSet: oszArrayBuffer,
  skin: buildSkin(skin, undefined, { mode: replay.mode }),
});

// Start playback: anchor the player's clock to the audio timeline, then go.
session.renderer.start();
session.player.setClockFn(session.audioSync.clockFn);
await session.audioSync.playFrom(0);
session.player.seek(0);
session.player.play();

// ...later
session.destroy();
```

## API overview

Everything is exported from the single entry point (`dist/index.js`, fully
typed by `dist/index.d.ts`). Three tiers:

**Parsing**

- `parseReplay(ArrayBuffer)` — decode a `.osr` (including the LZMA input-frame
  stream) into `ReplayData`.
- `parseBeatmap(text)` — decode a `.osu` into `BeatmapData`.
- `loadBeatmapSet(ArrayBuffer)` / `extractBeatmapBackground(...)` — unpack a
  `.osz` beatmap set.
- `loadSkin(...)` / `loadSkinFromDir(url)` / `mergeSkinAssets(...)` — skin
  loading (see [Skins](#skins)).
- `md5(bytes)` — the hash osu! uses to match replays to beatmaps.

**Headless analysis** (no canvas / skin / audio; Node-compatible)

- `analyzeReplay(beatmap, replay)` — dispatches on the replay's ruleset and
  returns `{ mode, modDiff, hitResults, scoreFrames, accFrames, comboFrames,
  urTimeline }`.
- `computeModDifficulty(...)`, `applyStacking(...)` — the pieces it's built on.
- Ruleset conversions consumers may need alongside the analysis outputs:
  `convertBeatmapToMania`, `convertBeatmapToCatch`, `applyPositionOffsets`, …

**Rendering + playback**

- `createReplaySession(inputs)` — the full pipeline: parse → difficulty →
  stacking → skin merge → `TimeMapper`/`Player`/`Renderer`/`AudioSync`, wired
  together and returned as a `CoreSession` with a `destroy()`.
- `buildSkin(base, overlay?, { mode? })` — merge skin layers before a session.
- `Renderer` / `RenderOptions`, `Player`, `TimeMapper`, `AudioSync` — the
  individual pieces, for custom wiring.
- `synthesizeAutoReplay` + `generate{Std,Taiko,Mania,Catch}AutoReplay` —
  perfect-play generation for beatmaps without a replay.
- `configureWorkers({ stretch })` — inject the worker bundle URL for
  off-thread DT/HT audio stretching.

## Skins

A skin is a required input to `createReplaySession`. This repo ships one ready
to use — the YUGEN skin, pre-extracted at `assets/skin/` (the examples load
it from there) — plus osu!'s 12 default fallback hitsounds at
`assets/lazer-defaults/` (pass their base URL as
`ReplaySessionInputs.lazerDefaultsUrl`; without them a synthesized fallback
click is used when a sample is missing from the skin).

`loadSkinFromDir(baseUrl)` consumes a static directory of pre-extracted skin
files with an `index.json` manifest:

```
<skin dir>/
  index.json          { "files": ["skin.ini", "hitcircle.png", ...] }
  skin.ini
  hitcircle.png
  ...
```

`scripts/extract-skin.mjs` produces this layout from any `.osk`:

```sh
node scripts/extract-skin.mjs "My Skin.osk" path/to/skin-dir
```

## Credits

- [Wieku/danser-go](https://github.com/Wieku/danser-go) — the osu!standard
  ruleset (judgement behavior, mod formulas, and much of the renderer's
  animation/layout detail) was built with danser as the reference
  implementation and validated against it.
- [ppy/osu](https://github.com/ppy/osu) — the taiko, catch, and mania rulesets
  were built and validated against osu! lazer's reference implementation.

## License

[MIT](LICENSE) — covers the code. The bundled sample assets are not ours:
the default hitsounds in `assets/lazer-defaults/` come from
[ppy/osu-resources](https://github.com/ppy/osu-resources) (CC BY-NC 4.0), and
the skin, beatmaps, and replays under `assets/` and `examples/*/assets/`
belong to their respective creators and are included as sample data only.
osu! is a trademark of ppy Pty Ltd; this project is not affiliated with or
endorsed by ppy.
