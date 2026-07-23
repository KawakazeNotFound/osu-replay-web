// Headless replay analysis: per-object judgements + score/acc/combo/UR timelines with no
// canvas, skin, or audio — for stats sites/bots. Dispatches on the replay's ruleset and
// reuses the exact pipelines a render session is built from, so results are identical to
// what rendered playback displays.

import type { BeatmapData, ReplayData, HitResult } from './types/index';
import { computeModDifficulty, type ModDifficulty } from './utils/modDifficulty';
import { applyStacking } from './utils/stacking';
import { computeHitResults } from './utils/hitJudge';
import { computeScoreTimeline, type ScoreFrame } from './utils/scoreProcessor';
import {
  computeAccTimeline, computeTaikoAccTimeline, computeComboTimeline,
  type AccFrame, type ComboFrame,
} from './renderer/HUDRenderer';
import {
  computeURTimeline, computeTaikoURTimeline, computeManiaURTimeline, type URTimeline,
} from './renderer/URBarRenderer';
import { convertBeatmapToTaiko } from './rulesets/taiko/converter';
import { taikoFrames } from './rulesets/taiko/input';
import { computeTaikoHitResults } from './rulesets/taiko/hitJudge';
import { computeTaikoScoreV1Timeline, computeTaikoScoreV2Timeline } from './rulesets/taiko/scoreProcessor';
import type { TaikoSession } from './rulesets/taiko/types';
import { convertBeatmapToMania } from './rulesets/mania/converter';
import { maniaFrames } from './rulesets/mania/input';
import { computeManiaHitResults } from './rulesets/mania/hitJudge';
import {
  computeManiaScoreTimeline, computeManiaAccTimeline, computeManiaComboTimeline,
} from './rulesets/mania/scoreProcessor';
import type { ManiaSession } from './rulesets/mania/types';
import { convertBeatmapToCatch } from './rulesets/catch/converter';
import { applyPositionOffsets } from './rulesets/catch/positions';
import { catchFrames } from './rulesets/catch/input';
import { computeCatchHitResults } from './rulesets/catch/hitJudge';
import { computeCatchAccTimeline, computeCatchScoreTimeline } from './rulesets/catch/scoreProcessor';

/** Everything `analyzeReplay` computes. All timelines are sorted by beatmap time (ms). */
export interface ReplayAnalysis {
  /** The replay's ruleset: 0 = osu!std, 1 = taiko, 2 = catch, 3 = mania. */
  mode: 0 | 1 | 2 | 3;
  /** Mod-adjusted difficulty (AR/CS/OD/HP, hit windows, speed, mod flags) used for judging. */
  modDiff: ModDifficulty;
  /** Per-object judgement events, in judgement order. */
  hitResults: readonly HitResult[];
  /** Score + grade timeline, one frame per scoring event. */
  scoreFrames: readonly ScoreFrame[];
  /** Running-accuracy timeline. */
  accFrames: readonly AccFrame[];
  /** Combo timeline (current + max combo). */
  comboFrames: readonly ComboFrame[];
  /** Hit-error (unstable rate) timeline; empty for catch (judgement is positional — no hit windows). */
  urTimeline: URTimeline;
}

/**
 * Judge a replay against its beatmap and compute the score/acc/combo/UR timelines,
 * without building a render session. Accepts std beatmaps for taiko/catch replays
 * (converted, as in-game); mania requires a mania beatmap. Throws on any other
 * beatmap/replay mode pairing.
 *
 * Note: for std replays this applies stacking to `beatmap` in place (idempotent —
 * offsets are recomputed from scratch each call).
 */
export function analyzeReplay(beatmap: BeatmapData, replay: ReplayData): ReplayAnalysis {
  const mode = replay.mode;
  if (mode !== 0 && mode !== 1 && mode !== 2 && mode !== 3) {
    throw new Error(`Unsupported replay mode ${mode}.`);
  }
  const compatible =
    mode === 0 ? beatmap.mode === 0 :
    mode === 3 ? beatmap.mode === 3 :
    beatmap.mode === mode || beatmap.mode === 0; // taiko/catch convert from std
  if (!compatible) {
    const modeName = ['osu!std', 'taiko', 'catch', 'mania'];
    throw new Error(`Cannot analyze a ${modeName[mode]} replay against a mode-${beatmap.mode} beatmap.`);
  }

  const modDiff = computeModDifficulty(beatmap, replay);

  if (mode === 0) {
    applyStacking(beatmap, modDiff);
    const { results } = computeHitResults(beatmap, replay, modDiff);
    return {
      mode, modDiff,
      hitResults:  results,
      scoreFrames: computeScoreTimeline(results, beatmap, modDiff),
      accFrames:   computeAccTimeline(results),
      comboFrames: computeComboTimeline(results),
      urTimeline:  computeURTimeline(results, beatmap, modDiff),
    };
  }

  if (mode === 1) {
    const objects = convertBeatmapToTaiko(beatmap);
    const inputEvents = taikoFrames(replay);
    // Minimal session: computeTaikoHitResults reads objects/inputEvents; the score
    // timelines additionally read beatmap/replay/hitResults. Render fields are unused.
    const session = { beatmap, replay, objects, inputEvents } as unknown as TaikoSession;
    const { results } = computeTaikoHitResults(session, modDiff);
    const scored = { ...session, hitResults: results } as TaikoSession;
    return {
      mode, modDiff,
      hitResults:  results,
      scoreFrames: modDiff.isLazer
        ? computeTaikoScoreV2Timeline(scored, modDiff)
        : computeTaikoScoreV1Timeline(scored, modDiff),
      accFrames:   computeTaikoAccTimeline(results),
      comboFrames: computeComboTimeline(results),
      urTimeline:  computeTaikoURTimeline(objects, results, modDiff),
    };
  }

  if (mode === 2) {
    const objects = convertBeatmapToCatch(beatmap, modDiff);
    applyPositionOffsets(objects, beatmap, modDiff);
    const catcherPath = catchFrames(replay);
    const results = computeCatchHitResults(objects, catcherPath, modDiff.cs);
    return {
      mode, modDiff,
      hitResults:  results,
      scoreFrames: computeCatchScoreTimeline(objects, results, beatmap, replay, modDiff),
      accFrames:   computeCatchAccTimeline(results),
      comboFrames: computeComboTimeline(results),
      urTimeline:  { hits: [], zones: [] },
    };
  }

  const { totalColumns, objects } = convertBeatmapToMania(beatmap, modDiff);
  const inputEvents = maniaFrames(replay, totalColumns);
  // Minimal session: computeManiaHitResults reads objects/inputEvents/totalColumns only.
  const session = { beatmap, replay, objects, inputEvents, totalColumns } as unknown as ManiaSession;
  const { results } = computeManiaHitResults(session, modDiff);
  return {
    mode, modDiff,
    hitResults:  results,
    scoreFrames: computeManiaScoreTimeline(results, objects, modDiff),
    accFrames:   computeManiaAccTimeline(results, modDiff),
    comboFrames: computeManiaComboTimeline(results, objects, modDiff),
    urTimeline:  computeManiaURTimeline(objects, results, modDiff),
  };
}
