# Dual-canvas example — two replays, one map, in lockstep

Two `createReplaySession`s side by side on the same beatmap. 
Session A drives audio and the shared clock; session B is muted and clock-locked to A.
 Imports exclusively from `../../dist/index.js`.

## Run it

1. Build the library:

   ```sh
   npm run build
   ```

2. Sample assets ship in `assets/`; swap in your own to view a different pair:

   - `assets/replay-a.osr` / `assets/replay-b.osr` — two replays **set on the
     same beatmap**, with the same speed mods (DT/HT/NC)
   - `assets/map.osz` — the beatmap set they were played on (must contain the
     `.osu` whose MD5 matches the replays' beatmap hash)
   - a skin — `main.js` loads it from `../../assets/skin`; see the
     minimal example's README for the directory layout

3. Serve the **repo root** (the page reaches up to `dist/`):

   ```sh
   python3 -m http.server 8080
   ```

4. Open <http://localhost:8080/examples/dual/> and press Play.

## Note

- **Build A from the `.osz` bytes**, then **build B from `sessionA.assets`**
  (`CoreSession.assets`, a `BeatmapAssets`). B skips the unzip, beatmap
  parse, and audio decode entirely.
- **Mute B** (`setSongVolume(0)` / `setEffectsVolume(0)`) so only A emits
  audio, and **clock-lock** B's player to A's audio timeline:
  `sessionB.player.setClockFn(sessionA.audioSync.clockFn)`.
- **Drive playback through A**: `sessionA.audioSync.playFrom(t)`, then
  `seek(t)` + `play()` on *both* players (same for pause/seek).

## Constraints

- Both replays must be on the same beatmap — asset reuse skips the `.osz`
  hash lookup for B, so the example checks `beatmapHash` itself.
- Both replays must carry the same speed mods; two different presentation
  timelines can't share one clock.
- Stacking is applied once, with replay A's mods — an HR-vs-noMod pair renders
  B with A's stack offsets (cosmetic).
