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
import { icon, iconCss } from './icons.js';
import type { RankCutoffs } from './accuracyGauge.js';
import { uiSounds } from '../player/uiSounds.js';
import { t } from '../player/i18n.js';
import {
  FONT, HIT_RESULT_COLOUR, LAYOUT, PANEL, PANEL_COLOUR, PERFECT_GRADIENT, RANK_COLOUR,
  formatAccuracy, formatPP, formatScore, getDifficultyColor,
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
  /**
   * True when `pp` was computed here by rosu-pp rather than taken from the score osu! recorded.
   * Both are real figures, but rosu-pp tracks osu!'s algorithms rather than being them, so a
   * computed value can differ from the site's — the panel says which one it is showing.
   */
  readonly ppComputed?: boolean;
  /** null when the star rating is unavailable. */
  readonly starRating: number | null;

  /** Row 2: GREAT / OK / MEH / MISS — counts only, no maximum. */
  readonly judgements: readonly StatisticEntry[];
  /** Row 3: SLIDER TICK / SLIDER END / SPINNER BONUS / SPINNER SPIN — count/max. */
  readonly subJudgements: readonly StatisticEntry[];

  /** Formatted date string, or null to omit the line. */
  readonly playedOn: string | null;
  readonly source?: string | null;
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

/** Handles the reveal sequence needs, alongside the panel root. */
export interface ResultsPanelHandle {
  readonly root: HTMLElement;
  readonly panel: HTMLElement;
  readonly setGaugeProgress: (p: number) => void;
  readonly gaugeProgress: number;
  readonly rankLetter: HTMLElement;
  readonly badges: readonly { readonly element: SVGGElement; readonly accuracy: number }[];
  readonly scoreElement: HTMLElement;
  /** Final score, so the reveal can roll up to it. */
  readonly score: number;
  readonly accuracyElement: HTMLElement | null;
  /** Final accuracy, 0–1. */
  readonly accuracy: number;
  /** Final awarded rank. */
  readonly rank: string;
  readonly statisticCells: readonly HTMLElement[];
  /** The green "watch replay" button, or null when no handler was supplied. */
  readonly replayButton: HTMLButtonElement | null;
}

/**
 * Builds the panel. `onWatchReplay`, when given, adds the button bar underneath — the panel
 * itself stays a pure presentation of the score.
 */
export function buildResultsPanel(
  data: ResultsPanelData,
  onWatchReplay?: () => void,
): ResultsPanelHandle {
  const root = div('rs-root');
  const panel = div('rs-panel');

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
  panel.append(top);

  const middle = div('rs-panel-middle');

  // 1. Metadata.
  const meta = div('rs-meta');
  meta.append(text('div', 'rs-title', data.title));
  meta.append(text('div', 'rs-artist', data.artist));
  middle.append(meta);

  // 2. Accuracy circle.
  const circleWrap = div('rs-circle');
  const circle = buildAccuracyCircle({
    accuracy: data.accuracy,
    rank: data.rank,
    cutoffs: data.cutoffs,
    size: LAYOUT.circleHeight,
  });
  circleWrap.append(circle.container);
  middle.append(circleWrap);

  // 3. Total score.
  const scoreElement = text('div', 'rs-score', formatScore(data.score));
  middle.append(scoreElement);

  // 4. Star rating row. Omitted entirely when unknown, rather than showing a placeholder that
  //    would read as a real difficulty value.
  if (data.starRating !== null) {
    const diffColor = getDifficultyColor(data.starRating);
    const starRow = div('rs-star-row');
    const badge = div('rs-star-badge');
    badge.style.background = diffColor.bg;
    badge.style.color = diffColor.text;
    if (diffColor.isHigh) {
      badge.style.border = '1px solid rgba(255, 215, 0, 0.7)';
    }
    // Drawn rather than the `★` glyph, which some platforms render as a full-colour emoji.
    badge.append(icon('star', { className: 'rv-icon rs-star-glyph' }));
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
    ? {
        label: 'pp',
        value: formatPP(data.pp),
        // Says where the number came from, the way the combo cell hangs "PERFECT" off itself.
        // A computed figure is real but not osu!'s own, and that difference matters to anyone
        // comparing it against their profile.
        ...(data.ppComputed === true ? { badge: 'CALCULATED' } : {}),
      }
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

  panel.append(middle);
  root.append(panel);

  // The button bar sits under the panel, as lazer's results screen does.
  let replayButton: HTMLButtonElement | null = null;
  if (onWatchReplay !== undefined) {
    const bar = div('rs-buttons');
    replayButton = document.createElement('button');
    replayButton.className = 'rs-watch';
    replayButton.type = 'button';
    replayButton.title = t('观看回放', 'Watch replay');
    // The download-with-tick, as osu! marks an available replay — not a cursor glyph.
    replayButton.append(
      icon('download-check', { className: 'rv-icon rv-icon-wide rs-watch-icon' }),
      text('span', 'rs-watch-label', t('观看回放', 'Watch replay')),
    );
    uiSounds.attachHoverClick(replayButton, { hover: 'button', click: false });
    replayButton.addEventListener('click', () => {
      uiSounds.playClick('button');
      onWatchReplay();
    });
    bar.append(replayButton);
    root.append(bar);
  }

  // Accuracy is the first cell of the first statistics row.
  const cells = [...root.querySelectorAll<HTMLElement>('.rs-stat')];
  const accuracyElement = cells[0]?.querySelector<HTMLElement>('.rs-stat-number') ?? null;

  return {
    root,
    panel,
    setGaugeProgress: circle.setProgress,
    gaugeProgress: circle.progress,
    rankLetter: circle.letter,
    badges: [...circle.badges.entries()].map(([rank, element]) => ({
      element,
      accuracy: data.cutoffs[rank as keyof typeof data.cutoffs],
    })),
    scoreElement,
    score: data.score,
    accuracyElement,
    accuracy: data.accuracy,
    rank: data.rank,
    statisticCells: cells,
    replayButton,
  };
}

/** Stylesheet for the panel. Values come from theme.ts so they stay traceable to lazer. */
export function resultsPanelCss(): string {
  return `
${iconCss()}
/* The rings and the centre letter share one box; the letter is an HTML overlay so its centring
   does not depend on SVG baseline metrics. */
.rs-circle-stack { position: relative; }
.rs-circle-stack svg { display: block; }
.rs-rank-letter {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: ${FONT.rankLetter.size}px;
  font-weight: ${FONT.rankLetter.weight};
  letter-spacing: ${FONT.rankLetter.letterSpacing}px;
  color: #ffffff;
  line-height: 1;
  pointer-events: none;
}
.rs-rank-letter > span {
  display: block;
  position: relative;
  /* Optical correction measured against the outer ring at the reference viewport. */
  left: -7.5px;
  top: -6px;
}
/* Badges scale about their own centre; the outer group carries the position. */
.rs-badge { transform-origin: 0 0; transform-box: view-box; }
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
.rs-star-glyph { font-size: 12px; }
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
.rs-stat-row { display: grid; gap: 6px; width: 100%; }
.rs-stat {
  text-align: center; min-width: 0;
  display: flex; flex-direction: column; align-items: stretch;
}
.rs-stat-header {
  height: ${LAYOUT.statHeaderHeight}px;
  line-height: ${LAYOUT.statHeaderHeight}px;
  border-radius: 999px;
  font-size: ${FONT.statHeader.size}px;
  font-weight: ${FONT.statHeader.weight};
  letter-spacing: 0.03em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding: 0 4px;
}
.rs-stat-value {
  display: flex; align-items: baseline; justify-content: center;
  font-variant-numeric: tabular-nums;
  margin-top: 3px;
  gap: 1.5px;
}
.rs-stat-number {
  font-size: ${FONT.statValue.size}px;
  font-weight: ${FONT.statValue.weight};
  letter-spacing: ${FONT.statValue.letterSpacing}px;
  line-height: 1;
}
.rs-stat-max {
  font-size: ${FONT.statMax.size}px;
  font-weight: ${FONT.statMax.weight};
  letter-spacing: ${FONT.statMax.letterSpacing}px;
  opacity: 0.7;
  line-height: 1;
}
.rs-perfect {
  font-size: ${FONT.perfect.size}px;
  font-weight: ${FONT.perfect.weight};
  background: linear-gradient(${PERFECT_GRADIENT.from}, ${PERFECT_GRADIENT.to});
  -webkit-background-clip: text; background-clip: text; color: transparent;
  letter-spacing: 0.08em;
  margin-top: 1px;
}
.rs-played-on {
  font-size: ${FONT.playedOn.size}px; font-weight: ${FONT.playedOn.weight};
  opacity: 0.65;
  margin-top: 4px;
}
.rs-root { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.rs-buttons {
  width: ${PANEL.expandedWidth}px;
  display: flex; gap: 8px;
}
/* The reference's wide green action button. */
.rs-watch {
  flex: 1;
  height: 42px;
  border: none;
  border-radius: 12px;
  background: #a3cc12;
  color: #1b2200;
  font-family: ${FONT.family};
  font-size: 14px;
  font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  cursor: pointer;
  transition: background 120ms ease, transform 80ms ease;
}
.rs-watch:hover { background: #b6e015; }
.rs-watch:active { transform: translateY(1px); }
.rs-watch-icon { height: 22px; }
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
