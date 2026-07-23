import type { BeatmapData, ReplayData, HitResult } from '../../types/index';
import type { ModDifficulty } from '../../utils/modDifficulty';
import type { SkinAssets } from '../../types/index';
import type { TaikoInputEvent } from './input';
import type { AccFrame, ComboFrame } from '../../renderer/HUDRenderer';
import type { ScoreFrame } from '../../utils/scoreProcessor';
import type { URTimeline } from '../../renderer/URBarRenderer';
import type { TaikoFlashlight } from './Flashlight';

/**
 * A converted taiko object. Note that stream-converted sliders emit multiple
 * Hits sharing one sourceIndex.
 */
export type TaikoHitObject = TaikoHit | TaikoDrumRoll | TaikoSwell;

/** A single don/kat note. Times are beatmap-clock milliseconds. */
export interface TaikoHit {
  kind: 'hit';
  time: number;
  isRim: boolean;
  /** Large/finisher: both halves of the same colour within <30ms. */
  isStrong: boolean;
  hitSound: number;
  /** Source .osu hitObject index. NOT unique: a stream-converted slider emits many Hits sharing it. */
  sourceIndex: number;
  /** Unique per converted note (index in the sorted objects array). Keys per-note render state. */
  noteId: number;
}

/** A drum roll (converted from a slider): mash either colour on the pre-computed ticks. */
export interface TaikoDrumRoll {
  kind: 'drumroll';
  time: number;
  endTime: number;
  isStrong: boolean;
  hitSound: number;
  tickTimes: number[];
  /** Per-tick hit window is tickInterval / 2. */
  tickInterval: number;
  sourceIndex: number;
}

/** A swell (converted from a spinner): alternate colours until requiredHits is reached. */
export interface TaikoSwell {
  kind: 'swell';
  time: number;
  endTime: number;
  requiredHits: number;
  hitSound: number;
  sourceIndex: number;
}

/**
 * Immutable per-replay state for taiko, produced once by `taikoRuleset.build`.
 * Converted objects, judged results, per-object scroll velocities and HUD
 * timelines are all precomputed; rendering only reads.
 */
export interface TaikoSession {
  readonly beatmap: BeatmapData;
  readonly replay: ReplayData;
  readonly modDiff: ModDifficulty;
  readonly skin: SkinAssets;
  readonly objects: readonly TaikoHitObject[];
  readonly inputEvents: readonly TaikoInputEvent[];
  /** Presses that hit no object (no Hit in window, outside every drum-roll/swell
   * span). Audio-only — AudioSync plays a bare don/kat so empty-section taps are
   * audible (stable behavior). Computed by computeTaikoHitResults. */
  readonly ghostTaps: readonly TaikoInputEvent[];
  readonly barLines: readonly number[];
  /** Velocities locked at each object's own start time (OverlappingScrollAlgorithm); mid-flight SV/BPM changes don't mutate them. */
  readonly objectVel: readonly number[];
  readonly barLineVel: readonly number[];
  /** Upper bound for the visible-range binary search; per-object pixel check culls the rest. */
  readonly maxScrollMs: number;
  readonly hitResults: readonly HitResult[];
  readonly accFrames: readonly AccFrame[];
  readonly comboFrames: readonly ComboFrame[];
  readonly scoreFrames: readonly ScoreFrame[];
  readonly urTimeline: URTimeline;
  readonly swellProgress: ReadonlyMap<number, SwellProgress>;
  /** Per-note judgement keyed by TaikoHit.noteId (NOT sourceIndex — stream-converted
   * sliders share a sourceIndex). Drives the 100ms miss fade and 900ms flying-hit arc. */
  readonly hitJudgmentByNote: ReadonlyMap<number, { time: number; judgement: number }>;
  readonly flashlight: TaikoFlashlight | null;
}

/** Per-swell press times plus the completion time, if the swell was cleared. Drives swell rendering. */
export interface SwellProgress {
  readonly tickTimes: readonly number[];
  readonly completionTime?: number;
}
