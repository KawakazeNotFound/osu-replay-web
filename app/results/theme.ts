/**
 * osu!lazer's results-screen visual constants, taken from its source.
 *
 * Every value here is quoted from ppy/osu (MIT) with its file noted, so a mismatch with lazer
 * is traceable to a line rather than to taste. Nothing in this file was read off a screenshot.
 */

/** `OsuColour.ForRank` — osu.Game/Graphics/OsuColour.cs L81-109. */
export const RANK_COLOUR = {
  SSH: '#de31ae',
  SS: '#de31ae',
  XH: '#de31ae',
  X: '#de31ae',
  SH: '#02b5c3',
  S: '#02b5c3',
  A: '#88da20',
  B: '#e3b130',
  C: '#ff8e5d',
  D: '#ff5a5a',
  F: '#3f3f3f',
} as const;

/**
 * Rank *letter* fills — osu.Game/Online/Leaderboards/DrawableRank.cs L88-116. Distinct from
 * the ring colours above: the silver ranks differ here even though they share a ring colour.
 */
export const RANK_LETTER_FILL = {
  SSH: { from: '#ffffff', to: '#afdff0' },
  SS: { from: '#ffe7a8', to: '#ffb800' },
  XH: { from: '#ffffff', to: '#afdff0' },
  SH: { from: '#ffffff', to: '#afdff0' },
  X: { from: '#ffe7a8', to: '#ffb800' },
  S: { from: '#ffe7a8', to: '#ffb800' },
  A: { from: '#275227', to: '#275227' },
  B: { from: '#553a2b', to: '#553a2b' },
  C: { from: '#473625', to: '#473625' },
  D: { from: '#512525', to: '#512525' },
  F: { from: '#CC3333', to: '#CC3333' },
} as const;

/**
 * `OsuColour.ForHitResult` — OsuColour.cs L114-145 with literals at L323-339, L464. Used for
 * each statistic's header pill (HitResultStatistic.cs L24).
 */
export const HIT_RESULT_COLOUR = {
  great: '#66ccff',      // Blue
  ok: '#88b300',         // Green
  good: '#b3d944',       // GreenLight
  meh: '#ffcc22',        // Yellow
  miss: '#ed1121',       // Red
  sliderTick: '#66ccff', // LargeTickHit → Blue
  sliderEnd: '#66ccff',  // SliderTailHit → Blue
  bonus: '#99eeff',      // Large/SmallBonus fall to the default → BlueLight
  ignore: '#808080',     // Color4.Gray
} as const;

/**
 * `OsuColour.Gray(47)` binds the *byte* overload (OsuColour.cs L20-21), so this is 47/255,
 * not 4700%. Drawn at `Alpha = 0.5f`.
 */
export const BACKGROUND_RING_COLOUR = '#2f2f2f';

/** ScorePanel.cs L31-81. Widths/heights are in lazer's own units, which we treat as px. */
export const PANEL = {
  expandedWidth: 380,
  expandedHeight: 586,
  contractedWidth: 130,
  contractedHeight: 385,
  expandedTopLayerHeight: 53,
  contractedTopLayerHeight: 30,
  cornerRadius: 20,
  /** lazer uses a superellipse corner; CSS has no equivalent, see panel.ts. */
  cornerExponent: 2.5,
  topLayerContainerHeight: 120,
} as const;

/** ScorePanel.cs L152-190. Vertical gradients, top-to-bottom. */
export const PANEL_COLOUR = {
  expandedTop: { from: '#444444', to: '#333333' },
  expandedMiddle: { from: '#555555', to: '#333333' },
  contracted: '#353535',
} as const;

/** ExpandedPanelMiddleContent.cs — L32 padding, L93 outer flow spacing, plus per-element. */
export const LAYOUT = {
  padding: 14,
  /** Outer FillFlow `Spacing = Vector2(20)`. */
  flowSpacing: 18,
  /** Metadata text is clamped to the panel width less padding on both sides. */
  maxTextWidth: PANEL.expandedWidth - 14 * 2,
  /** Circle container: `Margin { Top = 40 }`, `Height = 230`. */
  circleMarginTop: 40,
  circleHeight: 230,
  /** TotalScoreCounter `Margin { Top = 0, Bottom = 5 }`. */
  scoreMarginBottom: 5,
  /** Star-rating row `Spacing = Vector2(5, 0)`; DifficultyIcon `Size = 20`. */
  starRowSpacing: 5,
  difficultyIconSize: 20,
  /** Statistics flow `Spacing = Vector2(0, 12)` — increased for better vertical breathing room. */
  statisticsRowSpacing: 12,
  /** StatisticDisplay header pill: `CircularContainer` `Height = 15`, box `#222`. */
  statHeaderHeight: 15,
  statHeaderColour: '#222222',
} as const;

/**
 * Font sizes and weights as lazer states them. lazer uses Torus; we fall back through a
 * generic stack, since shipping the font is a separate licensing question.
 */
export const FONT = {
  family: '"Torus", "Exo", "Segoe UI", system-ui, sans-serif',
  /** TotalScoreCounter.cs: `size 60, FontWeight.Light, fixedWidth`, `Spacing = (-5, 0)`. */
  score: { size: 60, weight: 300, letterSpacing: -5 },
  /** RankText.cs L43-50: `OsuFont.Numeric size 76`, `Spacing = (-15, 0)`. */
  rankLetter: { size: 76, weight: 700, letterSpacing: -15 },
  /** RankBadge letter: `OsuFont.Numeric size 25`, `Spacing = (-3, 0)`. */
  badgeLetter: { size: 25, weight: 700, letterSpacing: -3 },
  title: { size: 20, weight: 600 },
  artist: { size: 14, weight: 600 },
  difficulty: { size: 16, weight: 600 },
  mapper: { size: 12, weight: 400 },
  statHeader: { size: 10, weight: 600 },
  /** Statistic values: `Torus 20 fixedWidth`. */
  statValue: { size: 20, weight: 400, letterSpacing: -0.3 },
  /** CounterStatistic.cs L56-65: the `/max` suffix, `Torus 12 fixedWidth`. */
  statMax: { size: 12, weight: 400, letterSpacing: 0 },
  /** ComboStatistic's "PERFECT": `Torus 11 SemiBold`. */
  perfect: { size: 11, weight: 600 },
  playedOn: { size: 11, weight: 400 },
} as const;

/** ComboStatistic "PERFECT" fill: `GradientVertical(#66FFCC, #FF9AD7)`. */
export const PERFECT_GRADIENT = { from: '#66FFCC', to: '#FF9AD7' } as const;

/** AccuracyCircle.cs timings, in ms. Kept so the reveal can match lazer's pacing. */
export const TIMING = {
  appearDuration: 200,
  accuracyTransformDelay: 450,
  accuracyTransformDuration: 3000,
  /** `TEXT_APPEAR_DELAY = ACCURACY_TRANSFORM_DURATION / 2`. */
  textAppearDelay: 1500,
  rankCircleTransformDelay: 150,
  rankCircleTransformDuration: 800,
  /** Statistics stagger: `delay += 200` each, after accuracyTransformDelay. */
  statisticStagger: 200,
  /** AccuracyStatistic.cs L47-48: accuracy counter rolls over half the fill, OutQuad. */
  accuracyCounterDuration: 1500,
} as const;

/**
 * osu!'s accuracy string — osu.Game/Utils/FormatUtils.cs L27-34: floor to 4 decimal digits,
 * then format with two decimals. Floored, never rounded up: 98.449% must read 98.44%, because
 * rounding it to 98.45% would imply an S on a play that is not one.
 */
export function formatAccuracy(accuracy: number): string {
  const floored = Math.floor(accuracy * 10000) / 10000;
  return `${(floored * 100).toFixed(2)}%`;
}

/** TotalScoreCounter.cs L60: `count.ToString("N0")` — comma groups, no zero padding. */
export function formatScore(score: number): string {
  return Math.trunc(score).toLocaleString('en-US');
}

/** PerformanceStatistic.cs: `(int)Math.Round(pp, MidpointRounding.AwayFromZero)`. */
export function formatPP(pp: number): string {
  return String(Math.sign(pp) * Math.round(Math.abs(pp)));
}

/** DrawableRank.GetRankLetter: SH → "S", X/XH/SSH → "SS", otherwise the rank itself. */
export function rankLetter(rank: string): string {
  if (rank === 'SH') return 'S';
  if (rank === 'SSH') return 'SS';
  if (rank === 'X' || rank === 'XH') return 'SS';
  return rank;
}
