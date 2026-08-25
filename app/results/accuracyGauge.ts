/**
 * osu!lazer's accuracy gauge, ported from its source rather than eyeballed.
 *
 * Reference: osu.Game/Screens/Ranking/Expanded/Accuracy/AccuracyCircle.cs (ppy/osu, MIT).
 * Every constant below is quoted from that file; the rank cutoffs are NOT, because lazer
 * reads them from the ruleset (`scoreProcessor.AccuracyCutoffFromRank`) — they are passed in
 * so this module never hardcodes a value it cannot cite.
 *
 * The gauge is a CircularProgress, so accuracy maps to progress directly (0–1); there is no
 * start-angle offset in lazer. What is *not* direct is the three corrections lazer applies
 * before filling, which is the whole reason this is a function and not a multiplication:
 * notch avoidance, the virtual SS region, and a small visual offset.
 */

/** Relative width of the rank circles. `RANK_CIRCLE_RADIUS = 0.05f` */
export const RANK_CIRCLE_RADIUS = 0.05;

/** Relative width of the circle showing the accuracy. `accuracy_circle_radius = 0.2f` */
export const ACCURACY_CIRCLE_RADIUS = 0.2;

/** "SS is displayed as a 1% region, otherwise it would be invisible." */
export const VIRTUAL_SS_PERCENTAGE = 0.01;

/** Spacing between grade circles, in accuracy terms: 2° of 360°. */
export const GRADE_SPACING_PERCENTAGE = 2.0 / 360;

/** lazer: "the gauge visually fills up a bit too much", so it is nudged back. */
export const VISUAL_ALIGNMENT_OFFSET = 0.001;

/** Accuracy gauge fill, `GradientVertical(#7CF6FF, #BAFFA9)`. */
export const GAUGE_GRADIENT = { from: '#7CF6FF', to: '#BAFFA9' } as const;

/** Background ring: `OsuColour.Gray(47)` at `Alpha = 0.5f`. */
export const BACKGROUND_RING_ALPHA = 0.5;

/** Background ring extends slightly inward: `InnerRadius = accuracy_circle_radius + 0.01f`. */
export const BACKGROUND_RING_INNER_RADIUS = ACCURACY_CIRCLE_RADIUS + 0.01;

/** Ranks the gauge draws a badge for, in ascending accuracy order. */
export type GaugeRank = 'D' | 'C' | 'B' | 'A' | 'S' | 'X';

/**
 * Accuracy cutoff per rank, as lazer's ruleset reports it (0–1). `X` is the SS cutoff.
 * Supplied by the caller: lazer does not define these in AccuracyCircle.cs.
 */
export type RankCutoffs = Readonly<Record<GaugeRank, number>>;

/** lazer's `Interpolation.Lerp(start, final, amount)`. */
function lerp(start: number, final: number, amount: number): number {
  return start + (final - start) * amount;
}

/** lazer's `Precision.AlmostEquals(value1, value2, difference)`. */
function almostEquals(a: number, b: number, difference: number): boolean {
  return Math.abs(a - b) <= difference;
}

export interface RankBadge {
  readonly rank: GaugeRank;
  /** The badge's own accuracy — lazer uses this for its appearance timing. */
  readonly accuracy: number;
  /** Where it sits on the ring, which is deliberately not its own accuracy. */
  readonly position: number;
}

/**
 * Badge placements. Each badge sits partway toward the *next* grade rather than on its own
 * cutoff, so it labels the arc it owns instead of the boundary. S and A use 0.25 rather than
 * 0.5 because lazer notes they "are moved down slightly to prevent collision with the SS
 * badge"; SS sits exactly on its cutoff.
 */
export function rankBadges(cutoffs: RankCutoffs): readonly RankBadge[] {
  return [
    { rank: 'D', accuracy: cutoffs.D, position: lerp(cutoffs.D, cutoffs.C, 0.5) },
    { rank: 'C', accuracy: cutoffs.C, position: lerp(cutoffs.C, cutoffs.B, 0.5) },
    { rank: 'B', accuracy: cutoffs.B, position: lerp(cutoffs.B, cutoffs.A, 0.5) },
    { rank: 'A', accuracy: cutoffs.A, position: lerp(cutoffs.A, cutoffs.S, 0.25) },
    {
      rank: 'S',
      accuracy: cutoffs.S,
      position: lerp(cutoffs.S, cutoffs.X - VIRTUAL_SS_PERCENTAGE, 0.25),
    },
    { rank: 'X', accuracy: cutoffs.X, position: cutoffs.X },
  ];
}

/**
 * How full the gauge should be for a score, as a 0–1 fraction of the ring.
 *
 * `isSS` must reflect the *rank*, not the accuracy: lazer fills the ring completely only for
 * X/XH, so a 100%-accuracy play that is not an SS (it happens — see the failed-S case) stops
 * short of full rather than lying about the grade.
 */
export function gaugeProgress(accuracy: number, isSS: boolean, cutoffs: RankCutoffs): number {
  let target = accuracy;

  // Nudge off a grade boundary so the fill does not sit exactly under a notch, which would
  // read as ambiguous between the two grades.
  const notches = [cutoffs.S, cutoffs.A, cutoffs.B, cutoffs.C];
  const half = GRADE_SPACING_PERCENTAGE / 2;
  for (const p of notches) {
    if (!almostEquals(p, target, half)) continue;
    const tippingDirection = target - p >= 0 ? 1 : -1;
    target = p + tippingDirection * half;
  }

  if (isSS) {
    target = 1;
  } else {
    // Anything short of SS must stay out of the virtual SS region.
    target = Math.min(cutoffs.X - VIRTUAL_SS_PERCENTAGE - half, target);
  }

  if (target < 1 && target >= VISUAL_ALIGNMENT_OFFSET) target -= VISUAL_ALIGNMENT_OFFSET;
  return target;
}

/**
 * Where the gauge stops for the "failed S" case: accuracy reached S but the rank is A
 * because of misses. lazer snaps the ring back to just under the S notch and drops the S
 * badge, so the ring cannot appear to award a grade the score did not earn.
 */
export function failedSProgress(cutoffs: RankCutoffs): number {
  return cutoffs.S - GRADE_SPACING_PERCENTAGE / 2 - VISUAL_ALIGNMENT_OFFSET;
}

/** True when lazer would show the failed-S animation: S-level accuracy, but rank A. */
export function isFailedS(accuracy: number, rank: string, cutoffs: RankCutoffs): boolean {
  return accuracy >= cutoffs.S && rank === 'A';
}
