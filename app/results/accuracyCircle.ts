/**
 * The accuracy circle as inline SVG.
 *
 * Three concentric layers, matching AccuracyCircle.cs's child order (back to front):
 *  1. a dim background ring spanning the whole circle,
 *  2. six graded arcs — one per rank — inside a container scaled to 0.8, separated by
 *     GRADE_SPACING gaps (the "notches"; RankNotch.cs is gone, GradedCircles.cs replaced it),
 *  3. the accuracy gauge itself, drawn over them in a cyan→green gradient.
 * Rank badges sit on top, and the rank letter in the middle.
 *
 * Angle convention, from RankBadge.cs L100-104 (`t = -π/2 - (1 - position)*2π`): progress 0 is
 * at the top and travels **clockwise**. osu!framework's `CircularProgress.InnerRadius` is a
 * thickness relative to the radius (1 = solid disc), so a ring's stroke width is
 * `innerRadius * radius` and its centreline sits at `radius - strokeWidth / 2`.
 */

import {
  ACCURACY_CIRCLE_RADIUS, BACKGROUND_RING_ALPHA, BACKGROUND_RING_INNER_RADIUS,
  GAUGE_GRADIENT, GRADE_SPACING_PERCENTAGE, RANK_CIRCLE_RADIUS, VIRTUAL_SS_PERCENTAGE,
  gaugeProgress, rankBadges,
  type GaugeRank, type RankCutoffs,
} from './accuracyGauge.js';
import {
  BACKGROUND_RING_COLOUR, FONT, RANK_COLOUR, RANK_LETTER_FILL, rankLetter,
} from './theme.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** `GradedCircles` lives in a container of `Size = 0.8` with `Padding = 2.5`. */
const GRADED_SCALE = 0.8;
const GRADED_PADDING = 2.5;

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Point on a circle at ring fraction `f`: 0 at the top, clockwise. */
function pointAt(cx: number, cy: number, r: number, f: number): { x: number; y: number } {
  const theta = -Math.PI / 2 + f * 2 * Math.PI;
  return { x: cx + Math.cos(theta) * r, y: cy + Math.sin(theta) * r };
}

/**
 * Arc path from fraction `from` to `to` on a circle of radius `r`. Stroked, so `r` is the
 * centreline. A full turn cannot be expressed as one arc — two halves are used instead.
 */
function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const sweep = to - from;
  if (sweep <= 0) return '';
  if (sweep >= 1) {
    const a = pointAt(cx, cy, r, 0);
    const b = pointAt(cx, cy, r, 0.5);
    return `M ${a.x} ${a.y} A ${r} ${r} 0 1 1 ${b.x} ${b.y} A ${r} ${r} 0 1 1 ${a.x} ${a.y}`;
  }
  const start = pointAt(cx, cy, r, from);
  const end = pointAt(cx, cy, r, to);
  const largeArc = sweep > 0.5 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export interface AccuracyCircleInputs {
  /** 0–1. */
  readonly accuracy: number;
  /** The awarded rank, which is what decides a full ring — not the accuracy. */
  readonly rank: string;
  readonly cutoffs: RankCutoffs;
  /** Rendered size in px; lazer gives the circle container a height of 230. */
  readonly size: number;
}

/**
 * The graded arcs, as GradedCircles.cs defines them: one per rank over
 * `[0,C] [C,B] [B,A] [A,S] [S, X−VIRTUAL_SS] [X−VIRTUAL_SS, 1]`, each inset by half the grade
 * spacing at both ends so the gaps read as notches. The SS arc is therefore the last 1%.
 */
export function gradedArcs(cutoffs: RankCutoffs): readonly { rank: GaugeRank; from: number; to: number }[] {
  const ssStart = cutoffs.X - VIRTUAL_SS_PERCENTAGE;
  const spans: { rank: GaugeRank; from: number; to: number }[] = [
    { rank: 'D', from: cutoffs.D, to: cutoffs.C },
    { rank: 'C', from: cutoffs.C, to: cutoffs.B },
    { rank: 'B', from: cutoffs.B, to: cutoffs.A },
    { rank: 'A', from: cutoffs.A, to: cutoffs.S },
    { rank: 'S', from: cutoffs.S, to: ssStart },
    { rank: 'X', from: ssStart, to: cutoffs.X },
  ];
  const half = GRADE_SPACING_PERCENTAGE / 2;
  return spans.map(s => ({ rank: s.rank, from: s.from + half, to: s.to - half }));
}

/** Builds the circle. Returns the root SVG plus the gauge path, so a caller can animate it. */
export function buildAccuracyCircle(inputs: AccuracyCircleInputs): {
  svg: SVGSVGElement;
  gauge: SVGPathElement;
  progress: number;
} {
  const { size, cutoffs, accuracy, rank } = inputs;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2;

  const svg = el('svg', {
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`,
    class: 'rs-accuracy-circle',
  });

  const gradientId = `rs-gauge-${Math.trunc(accuracy * 1e6)}`;
  const defs = el('defs', {});
  // The gauge gradient is vertical in lazer (`GradientVertical`).
  const grad = el('linearGradient', { id: gradientId, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    el('stop', { offset: '0', 'stop-color': GAUGE_GRADIENT.from }),
    el('stop', { offset: '1', 'stop-color': GAUGE_GRADIENT.to }),
  );
  defs.append(grad);

  const letterFill = RANK_LETTER_FILL[rank as keyof typeof RANK_LETTER_FILL]
    ?? RANK_LETTER_FILL.D;
  const letterGradId = `rs-rank-${rank}`;
  const letterGrad = el('linearGradient', { id: letterGradId, x1: '0', y1: '0', x2: '0', y2: '1' });
  letterGrad.append(
    el('stop', { offset: '0', 'stop-color': letterFill.from }),
    el('stop', { offset: '1', 'stop-color': letterFill.to }),
  );
  defs.append(letterGrad);
  svg.append(defs);

  // 1. Background ring — spans the full circle, slightly thicker so it peeks inside the gauge.
  const bgWidth = BACKGROUND_RING_INNER_RADIUS * outerR;
  svg.append(el('circle', {
    cx, cy, r: outerR - bgWidth / 2,
    fill: 'none',
    stroke: BACKGROUND_RING_COLOUR,
    'stroke-width': bgWidth,
    opacity: BACKGROUND_RING_ALPHA,
  }));

  // 2. Graded arcs, in their own scaled-down container.
  const gradedR = (size * GRADED_SCALE) / 2 - GRADED_PADDING;
  const gradedWidth = RANK_CIRCLE_RADIUS * gradedR;
  const gradedGroup = el('g', { class: 'rs-graded' });
  for (const arc of gradedArcs(cutoffs)) {
    const d = arcPath(cx, cy, gradedR - gradedWidth / 2, arc.from, arc.to);
    if (d === '') continue;
    gradedGroup.append(el('path', {
      d,
      fill: 'none',
      stroke: RANK_COLOUR[arc.rank],
      'stroke-width': gradedWidth,
    }));
  }
  svg.append(gradedGroup);

  // 3. The accuracy gauge itself.
  const isSS = rank === 'X' || rank === 'XH';
  const progress = gaugeProgress(accuracy, isSS, cutoffs);
  const gaugeWidth = ACCURACY_CIRCLE_RADIUS * outerR;
  const gauge = el('path', {
    d: arcPath(cx, cy, outerR - gaugeWidth / 2, 0, progress),
    fill: 'none',
    stroke: `url(#${gradientId})`,
    'stroke-width': gaugeWidth,
    'stroke-linecap': 'butt',
    class: 'rs-gauge',
  });
  svg.append(gauge);

  // Rank badges, on the graded ring.
  const badgeGroup = el('g', { class: 'rs-badges' });
  for (const badge of rankBadges(cutoffs)) {
    const p = pointAt(cx, cy, gradedR - gradedWidth / 2, badge.position);
    const g = el('g', { transform: `translate(${p.x} ${p.y})` });
    // RankBadge container `Size = Vector2(28, 14)`, origin centred.
    g.append(el('rect', {
      x: -14, y: -7, width: 28, height: 14, rx: 7,
      fill: RANK_COLOUR[badge.rank],
    }));
    const label = el('text', {
      x: 0, y: 0,
      fill: RANK_LETTER_FILL[badge.rank].from,
      'font-family': FONT.family,
      'font-size': 11,
      'font-weight': FONT.badgeLetter.weight,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
    });
    label.textContent = rankLetter(badge.rank);
    g.append(label);
    badgeGroup.append(g);
  }
  svg.append(badgeGroup);

  // The rank letter in the centre.
  const letter = el('text', {
    x: cx, y: cy,
    fill: `url(#${letterGradId})`,
    'font-family': FONT.family,
    'font-size': FONT.rankLetter.size,
    'font-weight': FONT.rankLetter.weight,
    'letter-spacing': FONT.rankLetter.letterSpacing,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    class: 'rs-rank-letter',
  });
  letter.textContent = rankLetter(rank);
  svg.append(letter);

  return { svg, gauge, progress };
}
