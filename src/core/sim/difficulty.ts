/**
 * 难度数值到时间/尺寸的换算。
 *
 * 公式取自 osu!lazer 源码。**这些常数是判定正确性的地基**,改动前务必
 * 对照 lazer 的实现。
 *
 * 已对照的源文件(2026-08-23,ppy/osu master):
 * - `osu.Game/Beatmaps/IBeatmapDifficultyInfo.cs` —— `DifficultyRange` / `DifficultyRangeInt`
 * - `osu.Game.Rulesets.Osu/Scoring/OsuHitWindows.cs` —— 命中窗口
 * - `osu.Game.Rulesets.Osu/Objects/OsuHitObject.cs` —— preempt / fade in / 半径
 * - `osu.Game/Rulesets/Objects/Legacy/LegacyRulesetExtensions.cs` —— CS → scale
 */

/**
 * 难度值 → 区间线性插值。osu 的标准做法:5 为中点,两侧斜率不同。
 *
 * lazer 写作 `mid + (mid - min) * (difficulty - 5) / 5`(v < 5 时该因子为负),
 * 与下面的写法数学等价。
 */
export function difficultyRange(value: number, min: number, mid: number, max: number): number {
  if (value > 5) return mid + ((max - mid) * (value - 5)) / 5;
  if (value < 5) return mid - ((mid - min) * (5 - value)) / 5;
  return mid;
}

/** AR = 0 时的 preempt(ms)。lazer 的 `OsuHitObject.PREEMPT_MAX`。 */
export const PREEMPT_MAX = 1800;
/** AR = 5 时的 preempt(ms)。lazer 的 `OsuHitObject.PREEMPT_MID`。 */
export const PREEMPT_MID = 1200;
/** AR = 10 时的 preempt(ms)。lazer 的 `OsuHitObject.PREEMPT_MIN`。 */
export const PREEMPT_MIN = 450;

/**
 * AR → preempt(物件出现到该被点击之间的时长,ms)。
 *
 * AR 0 → 1800ms,AR 5 → 1200ms,AR 10 → 450ms。
 *
 * ⚠️ **向零取整**。lazer 用的是 `DifficultyRangeInt`(即 `(int)` 强转)而非
 * 原始 double。整数 AR 与一位小数的 AR 本来就落在整数上,但 mod 调整过的 AR
 * 会产生小数(HR 把 AR 乘 1.4,如 AR 5.2 → 7.28 → preempt 858),
 * 此时取整与否就有差别。
 */
export function preemptFromAR(ar: number): number {
  return Math.trunc(difficultyRange(ar, PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN));
}

/**
 * preempt → fade in 时长(ms)。
 *
 * lazer 的公式:`400 * min(1, preempt / PREEMPT_MIN)`。注意它依赖 preempt
 * 而非直接依赖 AR —— 这个 `min` 是为了让 DT 把 preempt 压到 450 以下时
 * 圈仍能淡入完毕。
 */
export function fadeInFromPreempt(preempt: number): number {
  return 400 * Math.min(1, preempt / PREEMPT_MIN);
}

/**
 * OD → 命中窗口(ms,单边)。
 *
 * 返回 300 / 100 / 50 三档的容差,判定时用 `|delta| <= window` 比较。
 */
export interface HitWindows {
  readonly great: number;
  readonly ok: number;
  readonly meh: number;
  readonly miss: number;
}

/** miss 窗口是常数,**不随 OD 变化**。lazer 的 `OsuHitWindows.MISS_WINDOW`。 */
export const MISS_WINDOW = 400;

/**
 * OD → 命中窗口。
 *
 * ⚠️ 三档窗口都要 **`floor` 再减 0.5**,这是 lazer `OsuHitWindows.SetDifficulty`
 * 的做法,目的是复现 stable 按整数毫秒比较的行为。
 *
 * 差别是实打实的:OD 8 的 great 原始值为 32,取整减半后是 31.5 —— 于是
 * 偏差恰好 32ms 的一击在 lazer 里**不算** 300,直接返回 32 就会算成 300。
 * 这正是 A2(复现原始成绩)最容易栽的地方。
 *
 * miss 窗口不参与这个处理,它是常数 400。
 */
export function hitWindowsFromOD(od: number): HitWindows {
  return {
    great: floorWindow(difficultyRange(od, 80, 50, 20)),
    ok: floorWindow(difficultyRange(od, 140, 100, 60)),
    meh: floorWindow(difficultyRange(od, 200, 150, 100)),
    miss: MISS_WINDOW,
  };
}

function floorWindow(raw: number): number {
  return Math.floor(raw) - 0.5;
}

/** 物件基准半径(osu! 坐标系)。lazer 的 `OsuHitObject.OBJECT_RADIUS`。 */
export const OBJECT_RADIUS = 64;

/**
 * 老版本 osu 判定区取整误差的补偿系数。
 *
 * lazer 的 `broken_gamefield_rounding_allowance`:2013-05-04 之前的 osu 构建
 * 在宽屏下把判定区尺寸向下取整,导致半径算错。影响不到 1 个游戏像素,
 * 但 lazer 仍然把它应用到圈的 scale 上 —— 因为**回放还原的保真度**需要它。
 * 本项目做的就是回放还原,所以照抄。
 */
export const GAMEFIELD_ROUNDING_ALLOWANCE = 1.00041;

/**
 * CS → 圈半径(osu! 坐标系单位)。
 *
 * lazer 的链路是 `Radius = OBJECT_RADIUS * CalculateScaleFromCircleSize(cs, applyFudge: true)`,
 * 其中 scale = `(1 - 0.7 * (cs - 5) / 5) / 2 * 1.00041`。展开即:
 *
 * ```
 * radius = 64 * (1 - 0.14 * (cs - 5)) / 2 * 1.00041
 *        = (54.4 - 4.48 * cs) * 1.00041
 * ```
 *
 * ⚠️ 注意 lazer 传的是 `applyFudge: true`,所以那个 1.00041 **必须带上**。
 */
export function radiusFromCS(cs: number): number {
  return (OBJECT_RADIUS * (1 - (0.7 * (cs - 5)) / 5)) / 2 * GAMEFIELD_ROUNDING_ALLOWANCE;
}

/** 命中/miss 动画的尾巴时长(ms)。用于界定物件的视觉窗口右边界。 */
export const HIT_ANIMATION_MS = 240;

/** 时间轴在第一个物件之前 / 最后一个物件之后额外保留的余量(ms)。 */
export const TIMELINE_PADDING_MS = 1500;
