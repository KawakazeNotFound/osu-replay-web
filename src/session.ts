// The engine half of a replay session: everything from parsed inputs to a running-ready
// Player/Renderer/AudioSync. No DOM reads and no caching — hosts layer their own
// caching, skin resolution, and UI concerns on top of createReplaySession.

import { parseReplay } from './parsers/ReplayParser.js';
import { parseBeatmap } from './parsers/BeatmapParser.js';
import { mergeSkinAssets, mergeSounds, loadLazerDefaultSounds } from './parsers/SkinLoader.js';
import { loadBeatmapSet } from './parsers/BeatmapSetLoader.js';
import { parseStoryboard } from './storyboard/parse.js';
import type { Storyboard } from './storyboard/types.js';
import { applyStacking } from './utils/stacking.js';
import { computeModDifficulty, type ModDifficulty } from './utils/modDifficulty.js';
import { slideDurationMs } from './utils/sliderDuration.js';
import { Player } from './player/Player.js';
import { AudioSync } from './player/AudioSync.js';
import { TimeMapper } from './player/TimeMapper.js';
import { Renderer } from './renderer/Renderer.js';
import { warmSkinCaches, isBlankImage } from './renderer/HitObjectRenderer.js';
import { warmSliderPaths } from './renderer/SliderGeometry.js';
import type { BeatmapData, ReplayData, SkinAssets } from './types/index.js';

/**
 * Decoded beatmap-set assets, reusable across sessions built from the same .osr
 * (skin swaps, match partners). Produced by createReplaySession from an .osz buffer
 * (exposed as CoreSession.assets); pass one back as `beatmapSet` to skip the unzip,
 * re-parse, and re-stack. Reuse assumes the same replay/mods — stacking has already
 * been applied with the original replay's mod difficulty.
 */
export interface BeatmapAssets {
  /** Parsed .osu with stacking applied and `rawOsu` attached. */
  readonly beatmap: BeatmapData;
  readonly songBuffer: AudioBuffer | null;
  readonly background: ImageBitmap | null;
  readonly beatmapSounds: Map<string, AudioBuffer>;
  /**
   * Parsed storyboard (`.osb` merged with the `.osu`'s own `[Events]`), or null when the set
   * has none. Cheap to share across sessions: it holds no GPU resources.
   */
  readonly storyboard: Storyboard | null;
  /**
   * Undecoded image bytes from the archive, keyed as `SbDrawable.lookupPath`. Shared, because
   * each session decodes its own bitmaps from these on demand and releases them on stop.
   */
  readonly storyboardImages: Map<string, Uint8Array>;
  /** Decoded audio for the storyboard's `Sample` events, keyed by their `lookupPath`. */
  readonly storyboardSamples: Map<string, AudioBuffer>;
}

export interface ReplaySessionInputs {
  canvas: HTMLCanvasElement;
  audioContext: AudioContext;
  /** .osr bytes, or pre-parsed (so callers with their own parse cache skip a re-parse). */
  replay: ArrayBuffer | ReplayData;
  /** .osz bytes, or a previous session's decoded assets (skin-swap/partner fast path). */
  beatmapSet: ArrayBuffer | BeatmapAssets;
  /** Fully merged skin, from buildSkin. */
  skin: SkinAssets;
  /** "Use beatmap hitsounds": beatmap samples override skin per stem. Default true (osu!'s default). */
  beatmapHitsounds?: boolean;
  /** Supplies the canonical .osu when the .osz contains no hash match (stale-mirror recovery). */
  fetchOsuOverride?: () => Promise<Uint8Array>;
  /** User playback-rate multiplier on top of the mod speed. Default 1. */
  userRate?: number;
  /**
   * Base URL of the 12 default hitsound wavs (see `loadLazerDefaultSounds`). Default
   * `'skins/lazer-defaults'` relative to the page; a missing directory just weakens the
   * hitsound fallback cascade (synthesized sounds back it up).
   */
  lazerDefaultsUrl?: string;
  /**
   * On-screen zoom the host page applies to the canvas's CSS box; multiplies devicePixelRatio
   * in the 'auto' backing-store quality decision. Default 1 (canvas shown at CSS size).
   */
  pageZoom?: number;
}

export interface CoreSession {
  readonly player: Player;
  readonly renderer: Renderer;
  readonly audioSync: AudioSync;
  readonly timeMapper: TimeMapper;
  readonly beatmap: BeatmapData;
  readonly replay: ReplayData;
  readonly modDiff: ModDifficulty;
  /** 0 = osu!std, 1 = taiko, 2 = catch, 3 = mania (the replay's ruleset). */
  readonly mode: 0 | 1 | 2 | 3;
  readonly introOffsetMs: number;
  readonly speed: number;
  readonly background: ImageBitmap | null;
  /** Decoded set assets for reuse via `beatmapSet` on a later build. Ownership stays with the caller. */
  readonly assets: BeatmapAssets;
  /** Stops the RAF loop and releases audio nodes. Does not close `assets` bitmaps/buffers. */
  destroy(): void;
}

// Silent-intro trim: start playback 2 s before the first object's approach begins,
// but only when that skips at least 4 s (short intros play in full).
function computeIntroOffsetMs(beatmap: BeatmapData, preempt: number): number {
  const firstObjMs = beatmap.hitObjects[0]?.time;
  const firstHoldMs = beatmap.maniaHolds[0]?.time;
  let firstMs: number | undefined;
  if (firstObjMs !== undefined && firstHoldMs !== undefined) firstMs = Math.min(firstObjMs, firstHoldMs);
  else firstMs = firstObjMs ?? firstHoldMs;
  if (firstMs === undefined) return 0;

  const firstApproachMs = firstMs - preempt;
  const LEAD_MS         = 2000;
  const MIN_TRIM_MS     = 4000;

  const offset = Math.max(0, firstApproachMs - LEAD_MS);
  return offset >= MIN_TRIM_MS ? offset : 0;
}

// Outro trim: end playback 1 s after the last object ends, but only when that
// cuts at least 4 s off the replay's frame-derived duration.
function computeOutroOffsetMs(beatmap: BeatmapData, mapDurationMs: number): number {
  if (beatmap.hitObjects.length === 0 && beatmap.maniaHolds.length === 0) return 0;

  let lastEventMs = 0;
  for (const obj of beatmap.hitObjects) {
    let endMs: number;
    if (obj.type === 'spinner') {
      endMs = obj.endTime;
    } else if (obj.type === 'slider') {
      endMs = obj.time + slideDurationMs(beatmap, obj) * obj.slides;
    } else {
      endMs = obj.time;
    }
    lastEventMs = Math.max(lastEventMs, endMs);
  }
  for (const h of beatmap.maniaHolds) {
    if (h.endTime > lastEventMs) lastEventMs = h.endTime;
  }

  const TAIL_MS     = 1000;
  const MIN_TRIM_MS = 4000;

  const outroOffset = Math.max(0, mapDurationMs - (lastEventMs + TAIL_MS));
  return outroOffset >= MIN_TRIM_MS ? outroOffset : 0;
}

// Taiko's pippidon mascot is one character built from four state animations
// (idle/kiai/clear/fail), each a NO-DASH numbered frame set (pippidonidle0,
// pippidonidle1, ...). osu!stable/lazer pick the whole mascot from a single skin
// — frames are never mixed across skins. Our generic mergeSkinAssets can't enforce
// this for pippidon because its frames lack the trailing `-N` dash that marks an
// atomic family, so a selected skin shipping pippidonfail0/1 would otherwise let
// the base skin's pippidonfail2 leak into the gap (jarring: different character mid-loop).
//
// Three-way rule:
//  - Selected ships any NON-BLANK pippidon frame → it owns the entire mascot; the base's frames
//    are dropped, so a state the skin omits simply doesn't render (no character-swap fallback).
//  - Selected ships pippidon but ONLY blank (1×1) stubs → the author intentionally suppressed the
//    mascot (osu!stable's "1×1 transparent = hide this element" convention, same as taiko-hit300).
//    Honour it: drop the base's mascot too so NOTHING renders. (Skin '4sbet1' relies on this.)
//  - Selected ships no pippidon at all → fall back to the base's mascot (its stubs, if any, are dropped).
// Returns fresh SkinAssets (or the originals when nothing needs stripping); never
// mutates the input skin objects.
function resolveTaikoPippidonOwnership(
  base: SkinAssets,
  selected: SkinAssets,
): { base: SkinAssets; selected: SkinAssets } {
  const isPippidon = (k: string): boolean => k.startsWith('pippidon');
  const stripPippidon = (skin: SkinAssets): SkinAssets => {
    let hasPippidon = false;
    for (const k of skin.images.keys()) { if (isPippidon(k)) { hasPippidon = true; break; } }
    if (!hasPippidon) return skin;
    const images = new Map<string, ImageBitmap>();
    for (const [k, v] of skin.images) if (!isPippidon(k)) images.set(k, v);
    return { ...skin, images };
  };

  let selectedOwns = false;
  let selectedHasStub = false;
  for (const [k, bmp] of selected.images) {
    if (!isPippidon(k)) continue;
    selectedHasStub = true;
    if (!isBlankImage(bmp)) { selectedOwns = true; break; }
  }
  if (selectedOwns) return { base: stripPippidon(base), selected };
  // Blank-only stubs ⇒ intentional suppression: strip the mascot from BOTH skins.
  if (selectedHasStub) return { base: stripPippidon(base), selected: stripPippidon(selected) };
  // No pippidon shipped ⇒ keep the base's mascot.
  return { base, selected: stripPippidon(selected) };
}

/**
 * Merge an optional overlay skin over a base skin into the fully-merged SkinAssets a
 * session consumes. Handles the taiko pippidon single-owner rule (pass `mode: 1`) and
 * populates the dedicated spinnerImages channel from the overlay (or the base when no
 * overlay), so base-skin spinner sprites never leak into an overlay skin via the merge.
 */
export function buildSkin(
  base: SkinAssets,
  overlay?: SkinAssets,
  opts: { mode?: number } = {},
): SkinAssets {
  let skinAssets = base;
  // Spinner sprites intentionally don't fall back to the base — resolve them against the overlay directly.
  let spinnerSource = base;
  if (overlay !== undefined) {
    // Resolve pippidon ownership before merging so the taiko mascot comes from a
    // single skin (see resolveTaikoPippidonOwnership). No-op for non-taiko replays.
    const { base: pBase, selected: pSelected } = opts.mode === 1
      ? resolveTaikoPippidonOwnership(base, overlay)
      : { base, selected: overlay };
    skinAssets = mergeSkinAssets(pBase, pSelected);
    spinnerSource = overlay;
  }

  const spinnerImages = new Map<string, ImageBitmap>();
  for (const [key, val] of spinnerSource.images) {
    if (/^spinner-/i.test(key)) spinnerImages.set(key, val);
  }
  return { ...skinAssets, spinnerImages };
}

/**
 * Build an inert (not yet started) replay session: parse → mod difficulty → stacking →
 * sound merge + cache warm → time mapping → Player/Renderer/AudioSync. Start playback with
 * `renderer.start()` + `player.play()`; tear down with `destroy()`.
 */
export async function createReplaySession(inputs: ReplaySessionInputs): Promise<CoreSession> {
  const { canvas, audioContext } = inputs;

  const replayData = inputs.replay instanceof ArrayBuffer
    ? await parseReplay(inputs.replay)
    : inputs.replay;

  let assets: BeatmapAssets;
  const fresh = inputs.beatmapSet instanceof ArrayBuffer;
  if (inputs.beatmapSet instanceof ArrayBuffer) {
    const { osuBytes, audioBuffer: songBuffer, background, beatmapSounds, osbText, storyboardImages, storyboardSamples } =
      await loadBeatmapSet(inputs.beatmapSet, replayData.beatmapHash, audioContext, inputs.fetchOsuOverride);
    const osuText = new TextDecoder('utf-8').decode(osuBytes);
    const beatmap = parseBeatmap(osuText);
    // Stash the raw .osu on the beatmap: consumers that re-parse it themselves (e.g.
    // difficulty/pp calculators) read it from here, and it survives asset-reuse rebuilds.
    beatmap.rawOsu = osuBytes;
    // Both sources are drawn by osu!: the .osb is shared across the set's difficulties and
    // the .osu's own [Events] adds difficulty-specific sprites on top.
    const parsedStoryboard = parseStoryboard(osbText, osuText);
    assets = {
      beatmap, songBuffer, background, beatmapSounds,
      storyboard: parsedStoryboard.hasContent ? parsedStoryboard : null,
      storyboardImages,
      storyboardSamples,
    };
  } else {
    assets = inputs.beatmapSet;
  }
  const beatmapData   = assets.beatmap;
  const songBuffer    = assets.songBuffer;
  const background    = assets.background;
  const beatmapSounds = assets.beatmapSounds;

  // Supported: std/std, taiko/taiko, std-beatmap/taiko-replay (Mode:0 maps converted to taiko),
  // mania/mania, catch/catch + std-beatmap/catch-replay (Mode:0 maps converted to catch).
  // Rejected: taiko beatmap + std replay (nonsense); cross-mania converts (no pattern generators
  // yet); catch beatmap played in a non-catch ruleset, and catch replays on taiko/mania maps.
  const modeName = ['osu!std', 'taiko', 'catch', 'mania'];
  if (replayData.mode !== 0 && replayData.mode !== 1 && replayData.mode !== 2 && replayData.mode !== 3) {
    const rm = modeName[replayData.mode] ?? `mode ${replayData.mode}`;
    throw new Error(`This viewer does not support ${rm} replays yet.`);
  }
  if (beatmapData.mode !== 0 && beatmapData.mode !== 1 && beatmapData.mode !== 2 && beatmapData.mode !== 3) {
    const bm = modeName[beatmapData.mode] ?? `mode ${beatmapData.mode}`;
    throw new Error(`This viewer does not support ${bm} beatmaps yet.`);
  }
  if (beatmapData.mode === 1 && replayData.mode === 0) {
    throw new Error('Beatmap/replay mode mismatch: a taiko beatmap cannot be played in osu!std.');
  }
  if (beatmapData.mode === 3 && replayData.mode !== 3) {
    throw new Error('Beatmap/replay mode mismatch: a mania beatmap requires a mania replay.');
  }
  if (replayData.mode === 3 && beatmapData.mode !== 3) {
    throw new Error('Beatmap/replay mode mismatch: mania replays on non-mania maps (converts) are not supported yet.');
  }
  if (beatmapData.mode === 2 && replayData.mode !== 2) {
    throw new Error('Beatmap/replay mode mismatch: a catch beatmap requires a catch replay.');
  }
  // Catch replays run on native catch maps (2,2) or std→catch converts (0,2); not on taiko/mania maps.
  if (replayData.mode === 2 && beatmapData.mode !== 2 && beatmapData.mode !== 0) {
    throw new Error('Beatmap/replay mode mismatch: catch replays are only supported on catch maps or std→catch converts.');
  }

  const modDiff = computeModDifficulty(beatmapData, replayData);
  // Stacking mutates beatmapData; skip on reused assets (already applied; assumes matching mods).
  // Mania has no stacking concept and its hold objects don't carry a stackHeight field. Catch reads the
  // raw .osu X (OriginalX) — std stacking doesn't apply — so skip it for catch replays too (covers both
  // native maps and std→catch converts, where beatmapData.mode is still 0).
  if (fresh && beatmapData.mode !== 3 && replayData.mode !== 2) applyStacking(beatmapData, modDiff);

  warmSliderPaths(beatmapData);

  // Two sound maps for the "Beatmap Hitsounds" toggle. skin-only = skin assets alone;
  // merged = beatmap-shipped samples override skin per stem (lazer/stable default with
  // "Use beatmap hitsounds" = ON). Stem-aware so a beatmap `soft-hitnormal.ogg` displaces
  // a skin `soft-hitnormal.wav` (which the .wav-first lookup would otherwise win); overlay
  // = beatmap. AudioSync holds both and swaps live; skinAssets.sounds keeps the merged map
  // (the toggle's default-ON state).
  const skinOnlySounds = inputs.skin.sounds;
  const mergedSounds = mergeSounds(skinOnlySounds, beatmapSounds);
  const skinAssets: SkinAssets = { ...inputs.skin, sounds: mergedSounds };

  // Pre-populate hitCircleRatio/isBlankImage caches to avoid first-frame GPU→CPU readback stall.
  warmSkinCaches(skinAssets);

  let rawMapDurationMs = 0;
  for (const frame of replayData.frames) {
    if (frame.timeDelta >= 0) rawMapDurationMs += frame.timeDelta;
  }

  const introOffsetMs = computeIntroOffsetMs(beatmapData, modDiff.preemptMs);
  const outroOffsetMs = computeOutroOffsetMs(beatmapData, rawMapDurationMs);
  const timeMapper    = new TimeMapper(replayData.frames, introOffsetMs, outroOffsetMs, modDiff.speed);

  const player = new Player(timeMapper.presentationDurationMs);

  const renderer = new Renderer(
    canvas, player, replayData, beatmapData, skinAssets, timeMapper, background, modDiff,
    undefined, inputs.pageZoom ?? 1,
  );

  if (assets.storyboard !== null) {
    renderer.setStoryboard(
      assets.storyboard, assets.storyboardImages, beatmapData.widescreenStoryboard,
    );
  }

  const lazerDefaultSounds = await loadLazerDefaultSounds(audioContext, inputs.lazerDefaultsUrl);

  const mode = (replayData.mode === 1 ? 1 : replayData.mode === 3 ? 3 : replayData.mode === 2 ? 2 : 0) as 0 | 1 | 2 | 3;
  const audioSync = new AudioSync({
    ctx:          audioContext,
    songBuffer,
    skinSounds:   skinOnlySounds,
    mergedSounds,
    beatmapHitsounds: inputs.beatmapHitsounds ?? true,
    hitResults:   renderer.hitResults,
    beatmap:      beatmapData,
    introOffsetMs,
    speed:        modDiff.speed,
    isNC:         modDiff.isNC,
    userRate:     inputs.userRate ?? 1,
    mode,
    maniaSamples: renderer.maniaSamples,
    taikoGhostTaps: renderer.taikoGhostTaps,
    comboFrames:  renderer.comboFrames,
    lazerDefaultSounds,
    // Storyboard audio rides the hitsound scheduler's anchor, so it follows seeks and rate
    // changes for free.
    storyboardSamples: assets.storyboard?.samples ?? null,
    storyboardSampleBuffers: assets.storyboardSamples,
  });

  return {
    player,
    renderer,
    audioSync,
    timeMapper,
    beatmap: beatmapData,
    replay: replayData,
    modDiff,
    mode,
    introOffsetMs,
    speed: modDiff.speed,
    background,
    assets,
    destroy(): void {
      renderer.stop();
      audioSync.destroy();
    },
  };
}
