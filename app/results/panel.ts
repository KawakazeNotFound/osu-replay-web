/**
 * The expanded score panel, following ScorePanel.cs and ExpandedPanelMiddleContent.cs.
 *
 * Structure and order are lazer's: metadata, accuracy circle, total score, star-rating row,
 * beatmap line, then three statistics rows, then the played-on line. Sizes and spacings come
 * from theme.ts, which cites the source for each.
 *
 * One deliberate departure: lazer's panel corners are a superellipse (`CornerExponent = 2.5`),
 * which CSS cannot express. A plain `border-radius` is used, so corners are slightly rounder
 * than lazer's. Noted rather than silently approximated.
 */

import { buildAccuracyCircle } from './accuracyCircle.js';
import type { RankCutoffs } from './accuracyGauge.js';
import {
  FONT, HIT_RESULT_COLOUR, LAYOUT, PANEL, PANEL_COLOUR, PERFECT_GRADIENT, RANK_COLOUR,
  formatAccuracy, formatPP, formatScore,
} from './theme.js';

/** A statistic shown as a big number under an uppercase pill, optionally with a `/max`. */
export interface StatisticEntry {
  readonly label: string;
  readonly value: string;
  /** Rendered small and baseline-aligned after the value, as `/{max}`. */
  readonly max?: string;
  /** Pill colour; defaults to the neutral header colour. */
  readonly colour?: string;
  /** lazer drops a statistic's whole display to half alpha when it is not meaningful. */
  readonly dimmed?: boolean;
  /** Small gradient caption under the value — ComboStatistic's "PERFECT". */
  readonly badge?: string;
}

export interface ResultsPanelData {
  readonly title: string;
  readonly artist: string;
  readonly difficulty: string;
  readonly mapper: string;
  readonly playerName: string;
  readonly avatarUrl: string | null;

  readonly score: number;
  /** 0–1. */
  readonly accuracy: number;
  readonly rank: string;
  readonly cutoffs: RankCutoffs;

  readonly maxCombo: number;
  readonly beatmapMaxCombo: number | null;
  /** null when we cannot know it — see the pp note in SELF_HOSTING.md. */
  readonly pp: number | null;
  /** null when the star rating is unavailable. */
  readonly starRating: number | null;

  /** Row 2: GREAT / OK / MEH / MISS — counts only, no maximum. */
  readonly judgements: readonly StatisticEntry[];
  /** Row 3: SLIDER TICK / SLIDER END / SPINNER BONUS / SPINNER SPIN — count/max. */
  readonly subJudgements: readonly StatisticEntry[];

  /** Formatted date string, or null to omit the line. */
  readonly playedOn: string | null;
}

function div(className: string, style?: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (style !== undefined) Object.assign(node.style, style);
  return node;
}

function text(
  tag: keyof HTMLElementTagNameMap,
  className: string,
  content: string,
  style?: Partial<CSSStyleDeclaration>,
): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  if (style !== undefined) Object.assign(node.style, style);
  return node;
}

/** A statistic cell: uppercase pill above, value below. StatisticDisplay.cs L48-67. */
function statisticCell(entry: StatisticEntry): HTMLElement {
  const cell = div('rs-stat');
  if (entry.dimmed === true) cell.style.opacity = '0.5';

  const pill = text('div', 'rs-stat-header', entry.label.toUpperCase(), {
    background: entry.colour ?? LAYOUT.statHeaderColour,
  });
  cell.append(pill);

  const valueRow = div('rs-stat-value');
  valueRow.append(text('span', 'rs-stat-number', entry.value));
  if (entry.max !== undefined) {
    // lazer renders this as a separate, smaller, bottom-aligned sprite text.
    valueRow.append(text('span', 'rs-stat-max', `/${entry.max}`));
  }
  cell.append(valueRow);
  if (entry.badge !== undefined) cell.append(text('div', 'rs-perfect', entry.badge));
  return cell;
}

/** One equal-column row of statistics, matching lazer's single-row GridContainers. */
function statisticRow(entries: readonly StatisticEntry[]): HTMLElement {
  const row = div('rs-stat-row');
  row.style.gridTemplateColumns = `repeat(${entries.length}, 1fr)`;
  for (const entry of entries) row.append(statisticCell(entry));
  return row;
}

/** Builds the panel. Returns the root element; caller decides where it mounts. */
export function buildResultsPanel(data: ResultsPanelData): HTMLElement {
  const root = div('rs-panel');

  // Top layer — the avatar and player name live here (ExpandedPanelTopContent), not in the
  // middle content.
  const top = div('rs-panel-top');
  if (data.avatarUrl !== null) {
    const avatar = document.createElement('img');
    avatar.className = 'rs-avatar';
    avatar.src = data.avatarUrl;
    avatar.alt = '';
    top.append(avatar);
  }
  top.append(text('div', 'rs-player', data.playerName));
  root.append(top);

  const middle = div('rs-panel-middle');

  // 1. Metadata.
  const meta = div('rs-meta');
  meta.append(text('div', 'rs-title', data.title));
  meta.append(text('div', 'rs-artist', data.artist));
  middle.append(meta);

  // 2. Accuracy circle.
  const circleWrap = div('rs-circle');
  const { svg } = buildAccuracyCircle({
    accuracy: data.accuracy,
    rank: data.rank,
    cutoffs: data.cutoffs,
    size: LAYOUT.circleHeight,
  });
  circleWrap.append(svg);
  middle.append(circleWrap);

  // 3. Total score.
  middle.append(text('div', 'rs-score', formatScore(data.score)));

  // 4. Star rating row. Omitted entirely when unknown, rather than showing a placeholder that
  //    would read as a real difficulty value.
  if (data.starRating !== null) {
    const starRow = div('rs-star-row');
    const badge = div('rs-star-badge');
    badge.append(text('span', 'rs-star-glyph', '★'));
    badge.append(text('span', 'rs-star-value', data.starRating.toFixed(2)));
    starRow.append(badge);
    middle.append(starRow);
  }

  // 5. Beatmap line.
  const beatmap = div('rs-beatmap');
  beatmap.append(text('div', 'rs-difficulty', data.difficulty));
  const mapped = div('rs-mapper');
  mapped.append(text('span', 'rs-mapper-prefix', 'mapped by '));
  mapped.append(text('span', 'rs-mapper-name', data.mapper));
  beatmap.append(mapped);
  middle.append(beatmap);

  // 6. Statistics — three rows, as lazer groups them.
  const stats = div('rs-stats');
  const comboEntry: StatisticEntry = {
    label: 'max combo',
    value: String(data.maxCombo),
    ...(data.beatmapMaxCombo !== null ? { max: String(data.beatmapMaxCombo) } : {}),
    // ComboStatistic hangs "PERFECT" off the combo cell itself, not a row of its own.
    ...(data.beatmapMaxCombo !== null && data.maxCombo === data.beatmapMaxCombo
      ? { badge: 'PERFECT' }
      : {}),
  };
  const ppEntry: StatisticEntry = data.pp !== null
    ? { label: 'pp', value: formatPP(data.pp) }
    // Half alpha is lazer's own treatment for a pp value that does not apply; here it marks
    // one we cannot compute, rather than printing a number we made up.
    : { label: 'pp', value: '-', dimmed: true };

  stats.append(statisticRow([
    { label: 'accuracy', value: formatAccuracy(data.accuracy) },
    comboEntry,
    ppEntry,
  ]));

  if (data.judgements.length > 0) stats.append(statisticRow(data.judgements));
  if (data.subJudgements.length > 0) stats.append(statisticRow(data.subJudgements));
  middle.append(stats);

  // 7. Played-on line.
  if (data.playedOn !== null) {
    middle.append(text('div', 'rs-played-on', `Played on ${data.playedOn}`));
  }

  root.append(middle);
  return root;
}

/** Stylesheet for the panel. Values come from theme.ts so they stay traceable to lazer. */
export function resultsPanelCss(): string {
  return `
.rs-panel {
  width: ${PANEL.expandedWidth}px;
  font-family: ${FONT.family};
  color: #ffffff;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.rs-panel-top {
  height: ${PANEL.expandedTopLayerHeight}px;
  border-radius: ${PANEL.cornerRadius}px ${PANEL.cornerRadius}px 0 0;
  background: linear-gradient(${PANEL_COLOUR.expandedTop.from}, ${PANEL_COLOUR.expandedTop.to});
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  position: relative;
}
.rs-avatar {
  width: 40px; height: 40px; border-radius: 8px; object-fit: cover;
}
.rs-player { font-size: 16px; font-weight: 600; }
.rs-panel-middle {
  background: linear-gradient(${PANEL_COLOUR.expandedMiddle.from}, ${PANEL_COLOUR.expandedMiddle.to});
  border-radius: 0 0 ${PANEL.cornerRadius}px ${PANEL.cornerRadius}px;
  padding: ${LAYOUT.padding}px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${LAYOUT.flowSpacing}px;
  overflow: hidden;
}
.rs-meta { text-align: center; max-width: ${LAYOUT.maxTextWidth}px; }
.rs-title {
  font-size: ${FONT.title.size}px; font-weight: ${FONT.title.weight};
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rs-artist {
  font-size: ${FONT.artist.size}px; font-weight: ${FONT.artist.weight};
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rs-circle {
  margin-top: ${LAYOUT.circleMarginTop}px;
  height: ${LAYOUT.circleHeight}px;
  display: flex; align-items: center; justify-content: center;
}
.rs-score {
  font-size: ${FONT.score.size}px;
  font-weight: ${FONT.score.weight};
  letter-spacing: ${FONT.score.letterSpacing}px;
  font-variant-numeric: tabular-nums;
  margin-bottom: ${LAYOUT.scoreMarginBottom}px;
  line-height: 1;
}
.rs-star-row { display: flex; align-items: center; gap: ${LAYOUT.starRowSpacing}px; }
.rs-star-badge {
  display: inline-flex; align-items: center; gap: 3px;
  background: #ff66aa; color: #ffffff;
  border-radius: 999px; padding: 2px 8px;
  font-size: 12px; font-weight: 600;
}
.rs-beatmap { text-align: center; max-width: ${LAYOUT.maxTextWidth}px; }
.rs-difficulty {
  font-size: ${FONT.difficulty.size}px; font-weight: ${FONT.difficulty.weight};
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rs-mapper { font-size: ${FONT.mapper.size}px; font-weight: ${FONT.mapper.weight}; }
.rs-mapper-name { font-weight: 600; }
.rs-stats {
  width: 100%;
  display: flex; flex-direction: column;
  gap: ${LAYOUT.statisticsRowSpacing}px;
}
.rs-stat-row { display: grid; gap: 4px; width: 100%; }
.rs-stat { text-align: center; min-width: 0; }
.rs-stat-header {
  height: ${LAYOUT.statHeaderHeight}px;
  line-height: ${LAYOUT.statHeaderHeight}px;
  border-radius: 999px;
  font-size: ${FONT.statHeader.size}px;
  font-weight: ${FONT.statHeader.weight};
  letter-spacing: 0.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding: 0 4px;
}
.rs-stat-value {
  display: flex; align-items: baseline; justify-content: center;
  font-variant-numeric: tabular-nums;
}
.rs-stat-number {
  font-size: ${FONT.statValue.size}px;
  font-weight: ${FONT.statValue.weight};
  letter-spacing: ${FONT.statValue.letterSpacing}px;
}
.rs-stat-max {
  font-size: ${FONT.statMax.size}px;
  font-weight: ${FONT.statMax.weight};
  letter-spacing: ${FONT.statMax.letterSpacing}px;
  opacity: 0.7;
}
.rs-perfect {
  font-size: ${FONT.perfect.size}px;
  font-weight: ${FONT.perfect.weight};
  background: linear-gradient(${PERFECT_GRADIENT.from}, ${PERFECT_GRADIENT.to});
  -webkit-background-clip: text; background-clip: text; color: transparent;
  letter-spacing: 0.08em;
}
.rs-played-on {
  font-size: ${FONT.playedOn.size}px; font-weight: ${FONT.playedOn.weight};
  opacity: 0.7;
}
.rs-rank-letter { paint-order: stroke; }
`;
}

/** Statistic pill colours for the standard judgement labels, from OsuColour.ForHitResult. */
export const JUDGEMENT_COLOUR = {
  great: HIT_RESULT_COLOUR.great,
  ok: HIT_RESULT_COLOUR.ok,
  meh: HIT_RESULT_COLOUR.meh,
  miss: HIT_RESULT_COLOUR.miss,
  sliderTick: HIT_RESULT_COLOUR.sliderTick,
  sliderEnd: HIT_RESULT_COLOUR.sliderEnd,
  bonus: HIT_RESULT_COLOUR.bonus,
} as const;

/** Kept so callers can reach the rank colour without importing theme.ts directly. */
export { RANK_COLOUR };
