# Frontend wiring: Auto and Match modes

Backend is on `results-screen` as of `f9b821a`. This is what to call, plus the conventions this
codebase already holds itself to.

---

## 1. Conventions (please read before writing UI)

### No glyph characters — ever

`✓ ★ ⏸ ▶ ↺ ⏻ 🤖 ⚔️` and friends render as full-colour emoji on some platforms and as tofu on
others. **A stylesheet cannot correct this** — the shape belongs to the user's font stack, not to
us. Two of yours (`✓`, `★`) were already converted when your work was committed.

Everything drawn goes through `app/results/icons.ts`:

```ts
import { icon } from '../results/icons.js';
button.append(icon('play', { className: 'rv-icon' }));
```

Available now: `skip-start` `rewind` `step-back` `play` `pause` `step-forward` `fast-forward`
`skip-end` `reset` `power` `download-check` `link` `check` `star`.

For the Mode submenu you will want three more. Say the word and I will add them, or add them
yourself: one 24×24 path each, filled, `currentColor`, listed in `PATHS` and the `IconName` union.
Suggested names: `mode-single`, `mode-auto`, `mode-match`.

### Never edit `site/**`

`site/` is gitignored build output. `npm run build:app` and `npm run capture:upstream` both
regenerate it, so anything edited there is silently overwritten. **Source lives in `app/**` only.**

New modules must be added to `ENTRIES` in `scripts/build-app.mjs`, or they will not be bundled.

### Commit your work

Your last batch was deployed but uncommitted, and `site/` — the only copy — is a directory my
builds rebuild. It survived because I committed it for you; next time it may not.

### `app/fonts/` stays out of the repository

Torus is a commercial typeface ppy distributes under separate terms, so committing it would be
redistribution. `build-app.mjs` copies whatever is present at build time — hence the deployed page
has it and a fresh clone does not.

**Consequence for your optical correction:** the `left: -7.5px; top: -6px` on `.rs-rank-letter >
span` is measured against Torus. On a clone without it the stack falls back to Quicksand and that
offset is wrong. If you keep it, key it off a font-loaded check; otherwise it is a per-machine
constant.

---

## 2. Auto mode — already implemented, no new backend

This exists and `/app/dev` already uses it. `loadFromInput` routes a beatmap URL, or a bare id
with no session, straight to it:

```ts
import { loadAutoFromBeatmap } from './player/load.js';

const replay = await loadAutoFromBeatmap('5480991', {
  audioContext, canvas, log, skin: 'YUGEN',
});
flow.present(replay);
```

It fetches the canonical `.osu` from our proxy, resolves the set through the mirrors, generates a
perfect play, and returns the same `LoadedReplay` a real score does. **Auto is not a special
render path** — the generated frames run through the identical judge and renderer, so the results
panel, the storyboard and the transport all behave the same.

There is no `generateAutoReplay(beatmap, options)` wrapper and I would rather not add one: it
would hide three lines and unlock nothing. If you want it purely for symmetry in the Mode
switch, say so and I will add it.

`generateTaikoAutoReplay`, `generateManiaAutoReplay` and `generateCatchAutoReplay` are exported
too, but `loadAutoFromBeatmap` only wires osu!standard today.

---

## 3. Match mode — N canvases, not multi-cursor

**The shape you proposed does not match what the engine can do.** `Renderer` is one instance per
canvas per session all the way down — one skin merge, one ruleset session, one judged result
stream. Multi-cursor on a single canvas means reworking the render pipeline and the judged paths
it reads, which are the parts validated against danser and lazer.

Upstream does not do it either. From its own source:

```
// 8 canvas slots for 2v2/4v4; slot 0 is the primary canvas and also hosts the overview panel.
```

So: **one canvas per player, laid out in a grid.** Your job is the grid; the clock, audio and
asset sharing are handled.

### Loading

```ts
import { parseRoomRef, fetchMatchRoom, playableCount } from './player/matchRoom.js';
import { loadMatchMap } from './player/load.js';
import { createMatch } from './player/match.js';
import { loadSkin } from './player/skins.js';

const roomId = parseRoomRef(userInput);          // null → show an error, do not fetch
if (roomId === null) return;

const room = await fetchMatchRoom(roomId);       // no token needed
// room.name, room.roomType ('team_versus' | 'head_to_head' | …), room.maps in play order
// Each map: beatmapId, beatmapsetId, title, artist, version, coverUrl, scores[]
// Each score: username, avatarUrl, accuracy, maxCombo, totalScore, rank, mods[], hasReplay, team

// Let the user pick a map, then:
const { beatmapSet, players } = await loadMatchMap(room.maps[i], log);
```

`loadMatchMap` downloads replays **sequentially on purpose** — osu! allows 10 replay downloads per
minute per token, and a 4v4 map is 8 of them. Its `log` callback reports `downloading replay 3/8
(username)…`, so surface it; this step takes real time.

`playableCount(map)` is 0 when not signed in. **Grey out unplayable rows rather than letting a
click fail** — `score.hasReplay` is false for old scores whose replay osu! never stored, and that
is per-score, not per-map.

### Playing

```ts
const canvases = players.map(() => {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  return c;
});
// …lay the canvases out in your grid, then:

const match = await createMatch({
  beatmapSet,
  audioContext,
  skin: await loadSkin(skinName, audioContext),
  lazerDefaultsUrl: '/assets/lazer-defaults',
  players: players.map((p, i) => ({ ...p, canvas: canvases[i] })),
  audibleIndex: 0,
  log,
});

await match.play(0);
match.pause();
await match.seek(60_000);
match.destroy();          // call this before loading another map
```

`MatchHandle` gives you `slots` (name, session, canvas, team, audible), `audible`, `durationMs`,
and `standings()`.

### Standings

```ts
for (const row of match.standings()) {
  // position (1-based), name, team, score, combo, maxCombo, accuracy (0–1)
}
```

Sorted by score, ties keeping input order so a live board does not flicker between equal scores.
It reads the same timelines the canvases draw from, so it cannot disagree with what is on screen.

Call it on a timer, not per animation frame: `maxCombo` walks the combo array rather than
bisecting it (a running maximum has nothing to bisect on). ~4/second is plenty. If you do want
per-frame, tell me and I will add a cached prefix maximum.

### Things worth knowing

- **`audibleIndex` matters.** That slot's clock drives everyone. If one player quit early, its
  replay is shorter — pick a slot that covers the whole map or playback ends early for all.
- **Every slot gets its own `AudioSync`**; the silent ones are gain-zeroed. Do not call
  `playFrom` on a non-audible slot's `audioSync` — you will get a second copy of the song.
- **Teams are `null` in head-to-head.** Team colours only apply when `roomType === 'team_versus'`.
- **The room response carries no beatmap checksum** (I modelled one, then found it absent). The
  set is resolved from the `.osr`'s own `beatmapHash`, which is the exact difficulty the score was
  set on, so there is nothing to verify against and nothing that needs verifying.
- **`destroy()` before the next map.** It closes the shared background bitmap once; the sessions
  release their own storyboard bitmaps on stop.

### Layout suggestion

Nothing in the backend cares, but grids that keep 16:9 without letterboxing:

| Players | Grid |
|---|---|
| 1 | 1×1 |
| 2 | 1×2 (side by side) or 2×1 (stacked) |
| 3–4 | 2×2 |
| 5–6 | 2×3 |
| 7–8 | 2×4 |

At 8 canvases each session runs its own renderer at whatever backing-store scale it resolves, so
`RenderOptions.qualityScale` per slot is where to look if it gets heavy. `2×4` at 1280×720 each
is 8 full pipelines; if that is too much I can add a shared quality cap.

---

## 4. Mode switch

Backend has no mode concept — the three modes are just which loader you call:

| Mode | Call | Session shape |
|---|---|---|
| Replay | `loadOnlineScore` / `loadLocalReplay` | one session, `flow.present` |
| Auto | `loadAutoFromBeatmap` | one session, `flow.present` |
| Match | `loadMatchMap` → `createMatch` | N sessions, your own grid |

The first two are interchangeable and both go through `flow.present`. Match does not: it needs a
different layout and its own transport, since `buildFlow` owns exactly one canvas. Either extend
`buildFlow` to accept a canvas array, or give Match its own screen — your call, but be aware
`flow.ts` currently assumes one.

---

## 5. If something is missing

Ask rather than working around it. Three of the last four defects I fixed in this UI came from an
assumption that typechecked — `computeModDifficulty` taking a mods number where a `ReplayData`
belonged silently degraded every auto replay to nomod, and nothing caught it because the call site
was untyped JS. `app/` is typechecked now (`tsconfig.app.json`, wired into `npm test`); keep new
code inside that.
