import { EMPTY_PATH } from './sliderPath';
import type { SimBeatmap, SimHitObject } from './types';

/**
 * 测试用的物件 / 谱面工厂。
 *
 * ## 为什么单独一个文件
 *
 * `SimHitObject` 每加一个字段,四个测试文件里的字面量就都要改一遍(已经发生过
 * 三次:`stackHeight` / `tickCount` / `parts`+`path`)。集中到工厂里,以后加字段
 * 只改这里。
 *
 * 只被测试引用,所以不会进生产打包(没有 app 代码 import 它)。
 */

/** 默认难度:与 `placeholderBeatmap()` 一致,便于对照。 */
const DEFAULT_DIFFICULTY = {
  circleSize: 4,
  approachRate: 9,
  overallDifficulty: 8,
  drainRate: 5,
  sliderMultiplier: 1.4,
  sliderTickRate: 1,
} as const;

/**
 * 造一个物件。
 *
 * 未指定的位置字段会自动保持自洽:`endX/endY` 跟随 `x/y`,
 * `stackedX/stackedY` 在 `stackHeight` 为 0 时等于 `x/y` ——
 * 这样测试不会因为"忘了同步某个派生字段"而测出假结果。
 */
export function makeHitObject(overrides: Partial<SimHitObject> = {}): SimHitObject {
  const kind = overrides.kind ?? 'circle';
  const startTime = overrides.startTime ?? 0;
  const x = overrides.x ?? 256;
  const y = overrides.y ?? 192;

  return {
    kind,
    startTime,
    endTime: overrides.endTime ?? (kind === 'circle' ? startTime : startTime + 500),
    x,
    y,
    endX: overrides.endX ?? x,
    endY: overrides.endY ?? y,
    stackHeight: overrides.stackHeight ?? 0,
    stackedX: overrides.stackedX ?? x,
    stackedY: overrides.stackedY ?? y,
    spans: overrides.spans ?? 1,
    tickCount: overrides.tickCount ?? 0,
    parts: overrides.parts ?? [],
    path: overrides.path ?? EMPTY_PATH,
    newCombo: overrides.newCombo ?? false,
    // 1-based,与 lazer 的 ComboIndex 一致(首个物件是 1)
    comboIndex: overrides.comboIndex ?? 1,
    comboIndexWithOffsets: overrides.comboIndexWithOffsets ?? overrides.comboIndex ?? 1,
    indexInCombo: overrides.indexInCombo ?? 1,
  };
}

/** 造一张谱面。 */
export function makeSimBeatmap(
  hitObjects: readonly SimHitObject[],
  overrides: Partial<SimBeatmap> = {},
): SimBeatmap {
  return {
    hitObjects,
    breaks: [],
    difficulty: { ...DEFAULT_DIFFICULTY, ...overrides.difficulty },
    audioLeadIn: 0,
    stackLeniency: 0.7,
    // 默认"谱面没给颜色" —— 于是走 osu 默认调色板,与多数谱面一致
    comboColours: [],
    sliderTrackOverride: null,
    sliderBorder: null,
    ...overrides,
  };
}
