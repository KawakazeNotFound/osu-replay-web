# Changelog

## 0.1.1 — 2026-07-23

- README title updated to the published package name (`replayviewer-js`).
- `package.json`: added `repository`, `homepage`, `bugs`, and `keywords` so the
  npm page links back to GitHub. No code changes.

## 0.1.0 — 2026-07-23

Initial public release.

- Parsers for `.osr` replays (stable + lazer), `.osu`/`.osz` beatmaps, and
  skins (`.osk` or pre-extracted directories).
- Judgement engine for all four rulesets — osu!standard, taiko, catch, mania —
  re-simulating the play from raw input frames.
- Headless analysis (`analyzeReplay`) with score/accuracy/combo/UR timelines;
  Node-compatible.
- Canvas renderer + synchronized audio playback (`createReplaySession`), with
  mod support including pitch-correct DT/HT time-stretching.
- Auto-replay synthesis (`synthesizeAutoReplay`) for beatmaps without a replay.
- Runnable examples (`examples/minimal/`, `examples/dual/`, `examples/embed/`)
  with sample assets included.
