import { difficultyRange } from './difficulty';
import type { BreakPeriod, SimBeatmap } from './types';

/**
 * stable(ScoreV1)的记分。
 *
 * ## 来源
 *
 * - `osu.Game/Rulesets/Objects/Legacy/LegacyRulesetExtensions.cs`
 *   → `CalculateDifficultyPeppyStars`
 * - `osu.Game.Rulesets.Osu/Difficulty/OsuLegacyScoreSimulator.cs`
 *   → 分数累加与各部件的基础分
 *
 * ## 公式
 *
 * ```
 * 每次判定:
 *   accuracyScore += 基础分
 *   若该物件吃 combo 加成:
 *     comboScore += trunc(max(0, combo - 1) * trunc(基础分 / 25) * 难度系数)
 *
 * 总分 = (accuracyScore + comboScore) * mod 系数
 * ```
 *
 * ⚠️ 三处必须照抄的取整(lazer 源码里都有明确标注):
 *
 * 1. **`基础分 / 25` 是整数除法** —— lazer 注释标了
 *    `PossibleLossOfFraction (intentional to match osu-stable)`。
 *    300/25 = 12,100/25 = 4,50/25 = 2。
 * 2. **combo 用的是这次判定**之前**的值**,且 `max(0, combo - 1)`,
 *    所以第一个物件的 combo 加成是 0。
 * 3. **每个物件各自 trunc**,不是最后统一取整。
 *
 * ## 难度系数
 *
 * ```
 * objectToDrainRatio = drainLength != 0 ? clamp(物件数 / drainLength * 8, 0, 16) : 16
 * 难度系数 = round((HP + OD + CS + objectToDrainRatio) / 38 * 5)
 * ```
 *
 * ⚠️ lazer 全程用 `decimal`(80 位 x87 的替身),并要求 HP/OD/CS 按
 * float → double → decimal 逐级转,注释写明 "ARE IMPORTANT AND MUST REMAIN"。
 * **JS 只有 float64**,这是一处已知的潜在偏差来源 —— 见 TECH-NOTES B14。
 *
 * ## 各部件的基础分
 *
 * | 部件 | 基础分 | 吃 combo 加成 |
 * |---|---|---|
 * | circle / spinner | 判定值(300/100/50/0) | ✅ |
 * | slider(整体) | 判定值 | ✅ |
 * | 滑条头 / repeat / 末端 | 30 | ❌ |
 * | 滑条刻度 | 10 | ❌ |
 */

/** 滑条头 / repeat / 末端的基础分。 */
export const SLIDER_END_SCORE = 30;

/** 滑条刻度的基础分。 */
export const SLIDER_TICK_SCORE = 10;

/**
 * 难度系数("peppy stars")。
 *
 * @param objectCount 物件总数(circle + slider + spinner)
 * @param drainLengthSeconds 可玩时长减去 break,**取整到秒**
 */
export function difficultyPeppyStars(
  beatmap: SimBeatmap,
  objectCount: number,
  drainLengthSeconds: number,
): number {
  const d = beatmap.difficulty;

  const objectToDrainRatio =
    drainLengthSeconds !== 0
      ? clamp((objectCount / drainLengthSeconds) * 8, 0, 16)
      : 16;

  const sum = d.drainRate + d.overallDifficulty + d.circleSize + objectToDrainRatio;

  // lazer 用 decimal 的 Math.Round(银行家舍入)。JS 的 Math.round 是"半数向上",
  // 在 .5 边界上可能差 1 —— 已知偏差,见 TECH-NOTES B14
  return Math.round((sum / 38) * 5);
}

/**
 * drain 时长(秒,取整)。
 *
 * ⚠️ lazer 用的是**最后一个物件的 startTime**(不是 endTime),而且每个时间戳
 * **先各自四舍五入再相减**:
 * ```
 * breakLength = Σ (round(break.end) - round(break.start))
 * drainLength = (round(末物件.startTime) - round(首物件.startTime) - breakLength) / 1000
 * ```
 * 最后那个除法是整数除法(向零取整)。
 */
export function drainLengthSeconds(beatmap: SimBeatmap): number {
  const objects = beatmap.hitObjects;
  if (objects.length === 0) return 0;

  const breakLength = beatmap.breaks.reduce(
    (total: number, b: BreakPeriod) => total + (Math.round(b.end) - Math.round(b.start)),
    0,
  );

  const span =
    Math.round(objects[objects.length - 1]!.startTime) - Math.round(objects[0]!.startTime);

  return Math.trunc((span - breakLength) / 1000);
}

/** mod 对 stable 分数的系数。 */
export function legacyModMultiplier(rawMods: number): number {
  const BIT = {
    NF: 1, EZ: 2, HD: 8, HR: 16, DT: 64, RX: 128, HT: 256, NC: 512, FL: 1024, SO: 4096, AP: 8192,
  };

  // Relax / Autopilot 直接归零,不管前面乘了什么 —— lazer 是 `return 0`
  if (rawMods & (BIT.RX | BIT.AP)) return 0;

  let multiplier = 1;
  if (rawMods & BIT.NF) multiplier *= 0.5;
  if (rawMods & BIT.EZ) multiplier *= 0.5;
  if (rawMods & BIT.HT) multiplier *= 0.3;
  if (rawMods & BIT.HD) multiplier *= 1.06;
  if (rawMods & BIT.HR) multiplier *= 1.06;
  if (rawMods & (BIT.DT | BIT.NC)) multiplier *= 1.12;
  if (rawMods & BIT.FL) multiplier *= 1.12;
  if (rawMods & BIT.SO) multiplier *= 0.9;

  return multiplier;
}

/** 记分器的配置。 */
export interface StableScoringOptions {
  /** 难度系数。由 {@link difficultyPeppyStars} 算出 */
  readonly difficultyMultiplier: number;
  /** mod 系数。由 {@link legacyModMultiplier} 算出 */
  readonly modMultiplier: number;
}

/**
 * 一次判定的分数增量。
 *
 * @param baseScore 该部件的基础分(见文件头的表)
 * @param comboBefore 这次判定**之前**的 combo
 * @param affectsComboMultiplier 该部件是否吃 combo 加成
 */
export function scoreIncrementFor(
  baseScore: number,
  comboBefore: number,
  affectsComboMultiplier: boolean,
  options: StableScoringOptions,
): number {
  if (baseScore <= 0) return 0;
  if (!affectsComboMultiplier) return baseScore;

  // ⚠️ trunc(baseScore / 25) 是整数除法 —— lazer 标注了这是刻意匹配 stable
  const perCombo = Math.trunc(baseScore / 25) * options.difficultyMultiplier;
  const comboBonus = Math.trunc(
    Math.max(0, comboBefore - 1) * perCombo * options.modMultiplier,
  );

  return baseScore + comboBonus;
}

/** 从谱面与 mod 算出记分参数。 */
export function stableScoringFor(
  beatmap: SimBeatmap,
  rawMods: number,
): StableScoringOptions {
  return {
    difficultyMultiplier: difficultyPeppyStars(
      beatmap,
      beatmap.hitObjects.length,
      drainLengthSeconds(beatmap),
    ),
    modMultiplier: legacyModMultiplier(rawMods),
  };
}

/**
 * 转盘每秒要求转数 —— 记分不用,但与 `spinner.ts` 同源,放这里便于对照。
 *
 * 保留是因为 stable 的 bonus 分依赖它。bonus 尚未实现。
 */
export function spinnerSpinsPerSecond(overallDifficulty: number): number {
  return difficultyRange(overallDifficulty, 3, 5, 7.5);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
