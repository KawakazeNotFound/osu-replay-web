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

/**
 * The badge layer's `Padding { Vertical = -15, Horizontal = -20 }` is *negative*, so it
 * expands past the circle's bounds — badges ride outside the rings rather than on them. The
 * asymmetry makes their track a slight ellipse, which is why x and y differ here.
 */
const BADGE_OUTSET_X = 20;
const BADGE_OUTSET_Y = 15;

/** RankBadge container `Size = Vector2(28, 14)`. */
const BADGE_WIDTH = 28;
const BADGE_HEIGHT = 14;

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Point on an ellipse at ring fraction `f`: 0 at the top, clockwise. */
function pointAtEllipse(
  cx: number, cy: number, rx: number, ry: number, f: number,
): { x: number; y: number } {
  const theta = -Math.PI / 2 + f * 2 * Math.PI;
  return { x: cx + Math.cos(theta) * rx, y: cy + Math.sin(theta) * ry };
}

/** Point on a circle at ring fraction `f`: 0 at the top, clockwise. */
function pointAt(cx: number, cy: number, r: number, f: number): { x: number; y: number } {
  return pointAtEllipse(cx, cy, r, r, f);
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

/** Builds the circle. Returns the mountable wrapper plus handles the reveal sequence needs. */
export function buildAccuracyCircle(inputs: AccuracyCircleInputs): {
  /** Mount this: it stacks the rings and the centre letter. */
  container: HTMLElement;
  svg: SVGSVGElement;
  /** Reveals the gauge up to a 0–1 fraction of the ring. */
  setProgress: (p: number) => void;
  /** The fill this score settles at, after lazer's corrections. */
  progress: number;
  /** The centre rank letter, so the reveal can fade it in on its own schedule. */
  letter: HTMLElement;
  /** Badges keyed by rank, so each can pop in when the fill passes it. */
  badges: ReadonlyMap<string, SVGGElement>;
} {
  const { size, cutoffs, accuracy, rank } = inputs;
  // The SVG is larger than the circle so the badges, which sit outside it, are not clipped.
  // The margin has to clear the badge's own half-width too, not just its outset — with only the
  // outset, a badge centred on the canvas edge loses half its pill.
  const pad = Math.max(BADGE_OUTSET_X, BADGE_OUTSET_Y) + BADGE_WIDTH / 2;
  const canvas = size + pad * 2;
  const cx = canvas / 2;
  const cy = canvas / 2;
  const outerR = size / 2;

  const svg = el('svg', {
    width: canvas,
    height: canvas,
    viewBox: `0 0 ${canvas} ${canvas}`,
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

  // 3. The accuracy gauge itself. Drawn as a full circle and revealed with stroke-dasharray:
  // animating a dash offset is smooth and cheap, whereas rebuilding the arc path every frame
  // re-tessellates it and shows seams at the leading edge.
  const isSS = rank === 'X' || rank === 'XH' || rank === 'SS' || rank === 'SSH';
  const progress = gaugeProgress(accuracy, isSS, cutoffs);
  const gaugeWidth = ACCURACY_CIRCLE_RADIUS * outerR;
  const gaugeR = outerR - gaugeWidth / 2;
  const circumference = 2 * Math.PI * gaugeR;
  const gauge = el('path', {
    d: arcPath(cx, cy, gaugeR, 0, 1),
    fill: 'none',
    stroke: `url(#${gradientId})`,
    'stroke-width': gaugeWidth,
    'stroke-linecap': 'butt',
    'stroke-dasharray': circumference,
    'stroke-dashoffset': circumference,
    class: 'rs-gauge',
  });
  svg.append(gauge);

  /** Reveals the gauge up to `p` (0–1 of the ring). */
  const setProgress = (p: number): void => {
    const clamped = Math.max(0, Math.min(1, p));
    gauge.setAttribute('stroke-dashoffset', String(circumference * (1 - clamped)));
  };
  setProgress(progress);

  // Rank badges, on a track outside the rings (the badge layer's negative padding).
  const badgeGroup = el('g', { class: 'rs-badges' });
  const badges = new Map<string, SVGGElement>();
  for (const badge of rankBadges(cutoffs)) {
    const p = pointAtEllipse(cx, cy, outerR + BADGE_OUTSET_X, outerR + BADGE_OUTSET_Y, badge.position);
    // Two nested groups on purpose. A CSS `transform` animation *replaces* the `transform`
    // attribute, so animating this element directly dropped its translate and the badge scaled up
    // from the SVG's own origin — reading as a slide in from off-screen rather than a pop. The
    // outer group holds the position; the inner one is what gets animated.
    const anchor = el('g', { transform: `translate(${p.x} ${p.y})` });
    const g = el('g', { class: 'rs-badge' });
    anchor.append(g);
    // RankBadge container `Size = Vector2(28, 14)`, origin centred.
    g.append(el('rect', {
      x: -BADGE_WIDTH / 2, y: -BADGE_HEIGHT / 2,
      width: BADGE_WIDTH, height: BADGE_HEIGHT, rx: BADGE_HEIGHT / 2,
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
    badgeGroup.append(anchor);
    badges.set(badge.rank, g);
  }
  svg.append(badgeGroup);

  // The rank letter is an HTML overlay rather than SVG text.
  //
  // `dominant-baseline: central` centres on the font's em box, and for a capital letter the
  // unused descent space pushes the glyph visibly low — which is exactly what it did here, by
  // about 40px at size 76. Getting that right in SVG means measuring cap height at runtime;
  // flex centring an HTML element is correct for any font without measuring anything.
  const letter = document.createElement('div');
  letter.className = 'rs-rank-letter';
  const rankColour = RANK_COLOUR[rank as keyof typeof RANK_COLOUR] ?? RANK_COLOUR.D;
  // RankText.cs: a white letter with a glow in the rank's colour. The DrawableRank gradients are
  // for the small badges, not this.
  letter.style.textShadow = `0 0 18px ${rankColour}, 0 0 6px ${rankColour}`;
  // Keep the optical correction on a child so the reveal animation's transform on the wrapper
  // does not replace it. Torus's capital S has a visibly right/down-heavy ink box even when its
  // line box is mathematically centred; these offsets put the drawn glyph on the ring centre.
  const glyph = document.createElement('span');
  glyph.textContent = rankLetter(rank);
  letter.append(glyph);

  // One positioned wrapper holds both layers, so the caller does not have to.
  const container = document.createElement('div');
  container.className = 'rs-circle-stack';
  container.style.width = `${canvas}px`;
  container.style.height = `${canvas}px`;
  container.append(svg, letter);

  return { container, svg, setProgress, progress, letter, badges };
}
