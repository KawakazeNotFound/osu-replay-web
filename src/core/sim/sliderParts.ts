import type { HitObjectKind, SimBeatmap, SimHitObject } from './types';

/**
 * 滑条的嵌套部件(刻度 / repeat / 尾)与理论最大 combo。
 *
 * ## 来源
 *
 * 对照 `ppy/osu` master(2026-08-23 核对):
 * - `osu.Game.Rulesets.Osu/Objects/Slider.cs` → `ApplyDefaultsToSelf`
 * - `osu.Game/Rulesets/Objects/Legacy/LegacyRulesetExtensions.cs`
 *   → `GetPrecisionAdjustedBeatLength`
 * - `osu.Game/Rulesets/Objects/SliderEventGenerator.cs`(经 osu-classes 的
 *   `EventGenerator` 交叉比对)
 *
 * ## ⚠️ 一个把我带偏过的错误前提
 *
 * 最初想用"FC 回放的 maxCombo"反推刻度数,推出 `stable.osu` 应有 18 个刻度,
 * 而公式给 19,以为是浮点边界问题。**错在前提上:**
 *
 * **`countMiss == 0` 不等于 full combo。** stable 里漏掉滑条尾或某个刻度会产生
 * **slider break** —— 它打断 combo 但**不计入 miss**。所以 0 miss 的成绩
 * 完全可以没拿到理论最大 combo。
 *
 * 实测:`stable.osu` 理论最大 1152,该回放拿到 1151(最后一条滑条断了一次);
 * `lazer.osu` 理论 346 == 实际 346,那张才是真正的 full combo —— 也正是它
 * 精确确认了本文件的公式。
 *
 * 所以 `.osr` 的 maxCombo 只能当**上界**用,不能当等式,除非已知是真 FC。
 */

/** lazer 的 `OsuHitObject.BASE_SCORING_DISTANCE`。 */
export const BASE_SCORING_DISTANCE = 100;

/**
 * 刻度与滑条末端之间必须留出的最小距离。
 *
 * lazer `SliderEventGenerator`:`minDistanceFromEnd = velocity * 10`。
 * 太靠近末端的刻度会被丢掉(否则它与滑条尾几乎同时,不合理)。
 */
function minDistanceFromEnd(velocity: number): number {
  return velocity * 10;
}

/** lazer `SliderEventGenerator.SLIDER_MAX_DISTANCE`。 */
const SLIDER_MAX_DISTANCE = 100000;

export interface SliderTickInput {
  /** 路径长度(osu 单位) */
  readonly pathDistance: number;
  /** 每 ms 前进的距离。osu-parsers 已在解码时算好 */
  readonly velocity: number;
  /** span 数 = repeat + 1 */
  readonly spans: number;
  /** 该滑条起点处生效的(非继承)timing point 的 beatLength */
  readonly beatLength: number;
  /** 谱面的 SliderTickRate */
  readonly sliderTickRate: number;
}

/**
 * 刻度间距。
 *
 * lazer:`scoringDistance = Velocity * timingPoint.BeatLength`,然后
 * `TickDistance = scoringDistance / SliderTickRate * TickDistanceMultiplier`。
 *
 * ⚠️ lazer 的注释明确说**不要**把 `scoringDistance` 写成
 * `BASE_SCORING_DISTANCE * sliderMultiplier` —— 它刻意保留 stable 的浮点误差
 * ("intentionally introducing floating point errors to match stable")。
 * 所以这里也走 `velocity * beatLength` 这条路,而不是"化简"成常量乘法。
 *
 * `TickDistanceMultiplier` 对 v8 及以上的谱面是 1,故略去。
 */
export function tickDistanceOf(input: SliderTickInput): number {
  const scoringDistance = input.velocity * input.beatLength;
  return scoringDistance / input.sliderTickRate;
}

/**
 * 一条滑条的刻度总数。
 *
 * lazer 的生成逻辑是每个 span 各自铺刻度,从 `tickDistance` 起按步长累加,
 * 条件是 `distance < sliderDistance - minDistanceFromEnd`(**严格小于**)。
 * 每个 span 的刻度数相同,所以总数 = 单 span 数 × span 数。
 */
export function tickCountOf(input: SliderTickInput): number {
  const sliderDistance = Math.min(SLIDER_MAX_DISTANCE, input.pathDistance);
  const tickDistance = tickDistanceOf(input);

  // lazer:tickDistance 为 0 或无穷时完全不生成刻度
  if (!Number.isFinite(tickDistance) || tickDistance <= 0) return 0;

  const limit = sliderDistance - minDistanceFromEnd(input.velocity);

  let perSpan = 0;
  for (let d = tickDistance; d < limit; d += tickDistance) perSpan++;

  return perSpan * Math.max(1, input.spans);
}

/**
 * 一个物件对 combo 的贡献(全部命中时)。
 *
 * - circle / spinner:1
 * - slider:1(头)+ 刻度数 + repeat 数 + 1(尾)
 */
export function comboContributionOf(object: SimHitObject): number {
  if (object.kind !== 'slider') return 1;

  const repeats = Math.max(0, object.spans - 1);
  return 1 + object.tickCount + repeats + 1;
}

/**
 * 谱面的**理论最大 combo**(全部部件都命中)。
 *
 * 用途:A2 的上界断言。`.osr` 的 maxCombo 必须 `<=` 这个值;若已知回放是
 * 真 full combo(比如实测 `lazer.osu` 那张),则应**精确相等**。
 *
 * ⚠️ 不要反过来用它推刻度数 —— 见本文件顶部关于 slider break 的说明。
 */
export function theoreticalMaxCombo(beatmap: SimBeatmap): number {
  let total = 0;
  for (const o of beatmap.hitObjects) total += comboContributionOf(o);
  return total;
}

/** 便于调试:按物件类型统计 combo 贡献的构成。 */
export function comboBreakdown(beatmap: SimBeatmap): {
  readonly objects: number;
  readonly ticks: number;
  readonly repeats: number;
  readonly tails: number;
  readonly total: number;
} {
  let ticks = 0;
  let repeats = 0;
  let tails = 0;

  for (const o of beatmap.hitObjects) {
    if (o.kind !== 'slider') continue;
    ticks += o.tickCount;
    repeats += Math.max(0, o.spans - 1);
    tails += 1;
  }

  const objects = beatmap.hitObjects.length;
  return { objects, ticks, repeats, tails, total: objects + ticks + repeats + tails };
}

/** 供 loader 使用:判断某个种类是否需要算刻度。 */
export function needsTicks(kind: HitObjectKind): boolean {
  return kind === 'slider';
}
