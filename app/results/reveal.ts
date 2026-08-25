/**
 * The results reveal, sequenced as lazer does it.
 *
 * Timeline, all from AccuracyCircle.cs / ExpandedPanelMiddleContent.cs (see theme.ts TIMING):
 *
 *   0 ms      panel scales 0 → 1 over 200 ms (OutQuint) — "pops out from the centre"
 *   450 ms    the ring starts filling, 3000 ms, OutPow10
 *   450 ms    accuracy counter rolls up over 1500 ms (OutQuad)
 *   450 ms +  statistics fade in, staggered 200 ms apart
 *   1950 ms   the rank letter appears (450 + 3000/2)
 *   —         each rank badge pops when the fill passes its own accuracy
 *
 * The badge timing is the one part that is not a fixed offset: lazer inverts the fill easing to
 * work out *when* the ring will reach a badge, so badges pop as the fill sweeps past them rather
 * than on a schedule of their own. Because OutPow10 is heavily front-loaded, the two differ a
 * lot — a badge at 90% is passed in the first fifth of the fill, not at 90% of the duration.
 */

import { TIMING } from './theme.js';
import {
  after, group, outPow10, outQuad, outQuint, tween,
  type Cancellable,
} from './animate.js';
import { formatAccuracy, formatScore } from './theme.js';

export interface RevealTargets {
  /** The panel root; scaled up from nothing. */
  readonly panel: HTMLElement;
  /** Reveals the gauge to a 0–1 fraction. */
  readonly setGaugeProgress: (p: number) => void;
  /** Where the gauge settles. */
  readonly gaugeProgress: number;
  /** The centre rank letter. */
  readonly rankLetter: SVGTextElement;
  /** Badge elements by rank, with the accuracy each sits at. */
  readonly badges: readonly { readonly element: SVGGElement; readonly accuracy: number }[];
  /** Score text node and its final value. */
  readonly scoreElement: HTMLElement;
  readonly score: number;
  /** Accuracy text node and its final value (0–1). */
  readonly accuracyElement: HTMLElement | null;
  readonly accuracy: number;
  /** Statistic cells, revealed in order. */
  readonly statisticCells: readonly HTMLElement[];
}

/**
 * When the eased fill reaches `fraction` of its final value, as a 0–1 share of the fill's
 * duration. lazer solves this numerically (`inverseEasing`); a bisection is exact enough here
 * and cheaper to reason about than replicating its stepping loop.
 */
export function inverseEasing(
  easing: (t: number) => number,
  target: number,
  iterations = 40,
): number {
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (low + high) / 2;
    if (easing(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Puts every animated element in its pre-reveal state, so nothing flashes before it starts. */
export function prepareReveal(targets: RevealTargets): void {
  const { panel, rankLetter, scoreElement, accuracyElement, statisticCells } = targets;
  panel.style.transform = 'scale(0)';
  panel.style.transformOrigin = 'center center';
  targets.setGaugeProgress(0);
  rankLetter.style.opacity = '0';
  scoreElement.textContent = formatScore(0);
  if (accuracyElement !== null) accuracyElement.textContent = formatAccuracy(0);
  for (const cell of statisticCells) cell.style.opacity = '0';
  for (const badge of targets.badges) badge.element.style.opacity = '0';
}

/** Starts the reveal. Cancel the result to abort it and leave everything where it stands. */
export function startReveal(targets: RevealTargets): Cancellable {
  const parts: Cancellable[] = [];

  // The panel itself: scale 0 → 1.
  parts.push(tween({
    durationMs: TIMING.appearDuration,
    easing: outQuint,
    onUpdate: p => { targets.panel.style.transform = `scale(${p})`; },
  }));

  // The ring fill.
  parts.push(tween({
    delayMs: TIMING.accuracyTransformDelay,
    durationMs: TIMING.accuracyTransformDuration,
    easing: outPow10,
    onUpdate: p => { targets.setGaugeProgress(targets.gaugeProgress * p); },
  }));

  // The score rolls up over the same window as the fill.
  parts.push(tween({
    delayMs: TIMING.accuracyTransformDelay,
    durationMs: TIMING.accuracyTransformDuration,
    easing: outPow10,
    onUpdate: p => { targets.scoreElement.textContent = formatScore(targets.score * p); },
  }));

  // Accuracy rolls up over half of it, on a gentler curve.
  if (targets.accuracyElement !== null) {
    const element = targets.accuracyElement;
    parts.push(tween({
      delayMs: TIMING.accuracyTransformDelay,
      durationMs: TIMING.accuracyCounterDuration,
      easing: outQuad,
      onUpdate: p => { element.textContent = formatAccuracy(targets.accuracy * p); },
    }));
  }

  // Each badge pops as the fill sweeps past it.
  for (const badge of targets.badges) {
    if (targets.gaugeProgress <= 0) break;
    // Badges above the final fill are never reached, so they stay hidden.
    if (badge.accuracy > targets.gaugeProgress) continue;
    const share = badge.accuracy / targets.gaugeProgress;
    const at = TIMING.accuracyTransformDelay
      + inverseEasing(outPow10, share) * TIMING.accuracyTransformDuration;
    parts.push(after(at, () => {
      badge.element.style.opacity = '1';
      badge.element.animate(
        [{ transform: 'scale(0.4)' }, { transform: 'scale(1)' }],
        { duration: 150, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
    }));
  }

  // The rank letter, halfway through the fill.
  parts.push(after(TIMING.accuracyTransformDelay + TIMING.textAppearDelay, () => {
    targets.rankLetter.style.opacity = '1';
    targets.rankLetter.animate(
      [{ transform: 'scale(1.6)', opacity: '0' }, { transform: 'scale(1)', opacity: '1' }],
      { duration: 400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }));

  // Statistics, staggered.
  let delay = TIMING.accuracyTransformDelay;
  for (const cell of targets.statisticCells) {
    const at = delay;
    parts.push(after(at, () => {
      cell.style.opacity = '1';
      cell.animate(
        [{ transform: 'translateY(6px)', opacity: '0' }, { transform: 'none', opacity: '1' }],
        { duration: 200, easing: 'ease-out' },
      );
    }));
    delay += TIMING.statisticStagger;
  }

  return group(...parts);
}
