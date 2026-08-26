/**
 * Per-category breakdown of the sub-judgements osu!'s results screen shows in its third
 * statistics row: SLIDER TICK, SLIDER END, SPINNER SPIN and SPINNER BONUS, each as
 * achieved-of-possible.
 *
 * These cannot be read off `HitResult` alone. A slider's sub-judgements are all flagged
 * `isSliderSub` with no indication of which is a tick, a repeat arrow or the tail, and nothing
 * carries the per-category maximum at all. The classification exists inside the score processor
 * (`buildSliderSubKinds`) but is private to it, and the spinner maxima are functions of OD and
 * duration rather than of anything in the result stream. This module derives all of it from the
 * beatmap plus the judged results, so a host can render the row without guessing.
 */

import type { BeatmapData, HitResult, ReplayData } from '../types/index.js';
import { computeModDifficulty, type ModDifficulty } from './modDifficulty.js';
import {
  computeHitResults, lazerSpinnerMaxBonusSpins, lazerSpinnerRequirementFullSpins, sliderTickTimes,
} from './hitJudge.js';
import { slideDurationMs } from './sliderDuration.js';
import { sliderTickTimesLazer } from '../renderer/SliderGeometryLazer.js';

/** One row cell: how many were achieved, and how many the beatmap offered. */
export interface SubJudgementCount {
  readonly count: number;
  readonly max: number;
}

export interface SubJudgementBreakdown {
  /** Slider ticks and repeat arrows together, as lazer groups them under LargeTick. */
  readonly sliderTick: SubJudgementCount;
  /** Slider tails — one per slider. */
  readonly sliderEnd: SubJudgementCount;
  /** Spins up to the requirement plus lazer's two-spin gap (SmallBonus / SpinnerTick). */
  readonly spinnerSpin: SubJudgementCount;
  /** Spins past that, capped at the beatmap's maximum (LargeBonus / SpinnerBonusTick). */
  readonly spinnerBonus: SubJudgementCount;
}

/**
 * Which sub-judgement each `isSliderSub` result belongs to, in the order the judge emits them:
 * every tick and repeat in time order, then the tail.
 *
 * Mirrors the score processor's own `buildSliderSubKinds`. Duplicated rather than shared because
 * that one is a private implementation detail of ScoreV1 timing, and coupling this to it would
 * make either free to break the other; the two are checked against each other by test.
 */
function sliderSubKinds(
  beatmap: BeatmapData,
  isLazer: boolean,
): Map<number, ('tick' | 'repeat' | 'tail')[]> {
  const kinds = new Map<number, ('tick' | 'repeat' | 'tail')[]>();
  for (let i = 0; i < beatmap.hitObjects.length; i++) {
    const obj = beatmap.hitObjects[i]!;
    if (obj.type !== 'slider') continue;
    const slideDur = slideDurationMs(beatmap, obj);
    // Must match the judge's tick emission: lazer spaces ticks by distance, stable by time.
    const ticks = isLazer
      ? sliderTickTimesLazer(beatmap, obj, slideDur)
      : sliderTickTimes(beatmap, obj, slideDur);
    const events: { t: number; kind: 'tick' | 'repeat' }[] = [];
    for (const t of ticks) events.push({ t, kind: 'tick' });
    for (let edge = 1; edge < obj.slides; edge++) {
      events.push({ t: obj.time + slideDur * edge, kind: 'repeat' });
    }
    events.sort((a, b) => a.t - b.t);
    const list: ('tick' | 'repeat' | 'tail')[] = events.map(e => e.kind);
    list.push('tail');
    kinds.set(i, list);
  }
  return kinds;
}

/**
 * Counts the four sub-judgement categories.
 *
 * `results` must be the same stream the renderer and score processor use, so the counts agree
 * with the score shown beside them.
 *
 * Spinner figures use lazer's full-spin model even for a stable replay. The rotation itself is
 * measured from the replay either way; what comes from the model is the requirement and the
 * bonus cap, both of which are functions of OD and spinner duration — properties of the beatmap,
 * not of the scoring version. This is what lazer itself shows for an imported stable score.
 */
export function computeSubJudgements(
  beatmap: BeatmapData,
  replay: ReplayData,
  modDiff?: ModDifficulty,
): SubJudgementBreakdown {
  const diff = modDiff ?? computeModDifficulty(beatmap, replay);
  const { results, spinnerAngles } = computeHitResults(beatmap, replay, diff);
  const kinds = sliderSubKinds(beatmap, diff.isLazer);

  let tickCount = 0;
  let tickMax = 0;
  let endCount = 0;
  let endMax = 0;

  for (const list of kinds.values()) {
    for (const kind of list) {
      if (kind === 'tail') endMax++;
      else tickMax++;
    }
  }

  // Walk the results the same way the score processor does: per object, sub-results arrive in
  // the order `kinds` lists them.
  const cursor = new Map<number, number>();
  for (const result of results) {
    if (result.isSliderSub !== true) continue;
    const index = cursor.get(result.objectIndex) ?? 0;
    cursor.set(result.objectIndex, index + 1);
    const kind = kinds.get(result.objectIndex)?.[index];
    if (kind === undefined) continue;
    // A judgement of 0 is a missed tick/end; it still occupies its slot in the order.
    const hit = result.judgement !== 0;
    if (kind === 'tail') {
      if (hit) endCount++;
    } else if (hit) {
      tickCount++;
    }
  }

  let spinCount = 0;
  let spinMax = 0;
  let bonusCount = 0;
  let bonusMax = 0;

  for (let i = 0; i < beatmap.hitObjects.length; i++) {
    const obj = beatmap.hitObjects[i]!;
    if (obj.type !== 'spinner') continue;
    const durationMs = obj.endTime - obj.time;
    const required = lazerSpinnerRequirementFullSpins(diff.od, durationMs);
    const maxBonus = lazerSpinnerMaxBonusSpins(diff.od, durationMs);
    // The gap lazer leaves between finishing the requirement and the first bonus tick.
    const spinAllowance = required + 2;

    spinMax += spinAllowance;
    bonusMax += maxBonus;

    const angles = spinnerAngles.get(i);
    if (angles === undefined) continue;
    const abs = angles.absAngles;
    const total = abs.length > 0 ? abs[abs.length - 1]! : 0;
    const spins = Math.floor(total / (2 * Math.PI));

    spinCount += Math.min(spins, spinAllowance);
    bonusCount += Math.max(0, Math.min(spins - spinAllowance, maxBonus));
  }

  return {
    sliderTick: { count: tickCount, max: tickMax },
    sliderEnd: { count: endCount, max: endMax },
    spinnerSpin: { count: spinCount, max: spinMax },
    spinnerBonus: { count: bonusCount, max: bonusMax },
  };
}

/**
 * Same breakdown from an already-judged result stream, for callers that have one and do not want
 * the judge run a second time.
 *
 * Spinner categories are left at zero here: they need the rotation timeline, which is not part of
 * `HitResult`. Callers that want them use `computeSubJudgements`.
 */
export function sliderSubJudgementsFromResults(
  beatmap: BeatmapData,
  results: readonly HitResult[],
  isLazer: boolean,
): Pick<SubJudgementBreakdown, 'sliderTick' | 'sliderEnd'> {
  const kinds = sliderSubKinds(beatmap, isLazer);
  let tickCount = 0;
  let tickMax = 0;
  let endCount = 0;
  let endMax = 0;
  for (const list of kinds.values()) {
    for (const kind of list) {
      if (kind === 'tail') endMax++;
      else tickMax++;
    }
  }
  const cursor = new Map<number, number>();
  for (const result of results) {
    if (result.isSliderSub !== true) continue;
    const index = cursor.get(result.objectIndex) ?? 0;
    cursor.set(result.objectIndex, index + 1);
    const kind = kinds.get(result.objectIndex)?.[index];
    if (kind === undefined) continue;
    if (result.judgement === 0) continue;
    if (kind === 'tail') endCount++;
    else tickCount++;
  }
  return {
    sliderTick: { count: tickCount, max: tickMax },
    sliderEnd: { count: endCount, max: endMax },
  };
}
