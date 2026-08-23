/**
 * lazer 的 standardised 记分(ScoreV2)。
 *
 * ## 来源(2026-08-23 核 ppy/osu master)
 *
 * - `osu.Game/Rulesets/Scoring/ScoreProcessor.cs` → `ComputeTotalScore` / `ApplyResultInternal`
 * - `osu.Game/Rulesets/Scoring/HitResult.cs` → `HitResultExtensions` 的全部谓词
 *
 * ## 公式
 *
 * ```
 * Accuracy      = currentBaseScore / currentMaximumBaseScore
 * comboProgress = currentComboPortion / maximumComboPortion
 * accProgress   = currentAccuracyJudgementCount / maximumAccuracyJudgementCount
 *
 * 分数 = round( 500000 · Accuracy    · comboProgress
 *             + 500000 · Accuracy⁵  · accProgress
 *             + bonusPortion )
 * ```
 *
 * 累积规则(`ApplyResultInternal`):
 *
 * ```
 * 若 MaxResult.AffectsAccuracy():
 *     currentMaximumBaseScore    += 基础分(MaxResult)
 *     currentAccuracyJudgementCount++
 * 若 Type.AffectsAccuracy():
 *     currentBaseScore += 基础分(Type)
 * 若 Type.IsBonus():      currentBonusPortion += 基础分(Type)
 * 否则若 Type.IsScorable(): currentComboPortion += 基础分(MaxResult) · combo^0.5
 * ```
 *
 * ## 三处与 stable 记分根本不同的地方
 *
 * 1. **combo 是开平方(`COMBO_EXPONENT = 0.5`)**,不是线性。stable 的 ScoreV1 里
 *    combo 线性放大分数,所以长图能上千万;lazer 开方后再归一化到
 *    `comboPortion / maximumComboPortion`,**总分恒 ≤ 100 万**。
 * 2. **准确率进了两次**:一次线性(乘 comboProgress 那半),一次五次方
 *    (`Accuracy⁵`)。五次方让 99% 和 100% 的差距被放大。
 * 3. **上限来自"完美一遍"的模拟**(`Reset` 里跑一次 autoplay)。所以算分必须先
 *    把整张图按满分走一遍求出 `maximumComboPortion` 等 —— 见 {@link lazerMaxima}。
 */

import type { JudgementPart, SimBeatmap } from './types';
import { HitResult } from './types';

/** `ScoreProcessor.MAX_SCORE`。 */
export const MAX_SCORE = 1_000_000;

/** `ScoreProcessor.COMBO_EXPONENT`。combo 开平方就是靠它封顶。 */
export const COMBO_EXPONENT = 0.5;

/**
 * lazer 的 `HitResult`,只保留 osu! standard 用得到的成员。
 *
 * ⚠️ 与我们自己的 {@link HitResult} 不是一回事:我们的是"判定档位"
 * (300/100/50/miss),lazer 的还编码了**部件类型**(tick / tail / bonus)。
 * 记分必须用 lazer 的这套 —— 基础分与谓词都挂在它上面。
 */
export type LazerResult =
  | 'great'
  | 'ok'
  | 'meh'
  | 'miss'
  | 'largeTickHit'
  | 'largeTickMiss'
  | 'smallTickHit'
  | 'smallTickMiss'
  | 'sliderTailHit'
  | 'smallBonus'
  | 'largeBonus'
  | 'ignoreHit'
  | 'ignoreMiss';

/**
 * `ScoreProcessor.GetBaseScoreForResult`。
 *
 * ⚠️ `sliderTailHit` 是 **150** —— 比 largeTick 的 30 高一档,这是 lazer
 * 刻意"提高滑条末端权重"的设计(源码注释:"increase the valuation of the
 * final tick of a slider")。
 */
export function baseScoreOf(result: LazerResult): number {
  switch (result) {
    case 'great':
      return 300;
    case 'ok':
      return 100;
    case 'meh':
      return 50;
    case 'sliderTailHit':
      return 150;
    case 'largeTickHit':
      return 30;
    case 'smallTickHit':
      return 10;
    case 'smallBonus':
      return 10;
    case 'largeBonus':
      return 50;
    default:
      // miss / largeTickMiss / smallTickMiss / ignoreHit / ignoreMiss
      return 0;
  }
}

/** `HitResultExtensions.IsHit`。 */
export function isHit(result: LazerResult): boolean {
  switch (result) {
    case 'miss':
    case 'largeTickMiss':
    case 'smallTickMiss':
    case 'ignoreMiss':
      return false;
    default:
      return true;
  }
}

/** `HitResultExtensions.IsBonus`。 */
export function isBonus(result: LazerResult): boolean {
  return result === 'smallBonus' || result === 'largeBonus';
}

/**
 * `HitResultExtensions.IsScorable`。
 *
 * 源码是 `result >= Miss && result < IgnoreMiss`(按枚举声明顺序),外加
 * `SliderTailHit` 特判为 true。落到我们这套字面量上就是:
 * **除 `ignoreHit` / `ignoreMiss` 之外全都算**。
 */
export function isScorable(result: LazerResult): boolean {
  return result !== 'ignoreHit' && result !== 'ignoreMiss';
}

/**
 * `HitResultExtensions.AffectsAccuracy` = `IsScorable && !IsBonus`。
 *
 * 所以 bonus(转盘刻度)**不进准确率**,只进 `bonusPortion`。
 */
export function affectsAccuracy(result: LazerResult): boolean {
  return isScorable(result) && !isBonus(result);
}

/**
 * `HitResultExtensions.AffectsCombo`。
 *
 * ⚠️ **`ignoreMiss` 不在这个列表里** —— 这正是 lazer 与 stable 的关键分歧:
 * lazer 的滑条末端 `MinResult` 是 `IgnoreMiss`,所以**漏掉末端既不断 combo
 * 也不加 combo**;stable(`ClassicSliderBehaviour`)用的是 `LargeTickMiss`,
 * 那个**会断 combo**。
 */
export function affectsCombo(result: LazerResult): boolean {
  switch (result) {
    case 'miss':
    case 'meh':
    case 'ok':
    case 'great':
    case 'largeTickHit':
    case 'largeTickMiss':
    case 'sliderTailHit':
      return true;
    default:
      return false;
  }
}

/** `HitResultExtensions.BreaksCombo` = `AffectsCombo && !IsHit`。 */
export function breaksCombo(result: LazerResult): boolean {
  return affectsCombo(result) && !isHit(result);
}

/** `HitResultExtensions.IncreasesCombo` = `AffectsCombo && IsHit`。 */
export function increasesCombo(result: LazerResult): boolean {
  return affectsCombo(result) && isHit(result);
}

/** 一个部件在 lazer 里的"满分结果"与"实际结果"。 */
export interface LazerJudgement {
  /** `result.Judgement.MaxResult` —— 该部件**理论上**能拿到的最好结果 */
  readonly maxResult: LazerResult;
  /** `result.Type` —— 实际拿到的结果 */
  readonly type: LazerResult;
}

/**
 * 某类部件在 lazer 里的 `MaxResult`。
 *
 * | 我们的 part | lazer 的类 | MaxResult |
 * |---|---|---|
 * | `circle` | `HitCircle` | `Great` |
 * | `sliderHead` | `SliderHeadCircle` | `Great` |
 * | `sliderTick` | `SliderTick` | `LargeTickHit` |
 * | `sliderRepeat` | `SliderRepeat` | `LargeTickHit` |
 * | `sliderTail` | `SliderTailCircle`(非 classic) | `SliderTailHit` |
 * | `spinner` | `Spinner` | `Great` |
 *
 * ⚠️ 滑条**本身**在 lazer 里是 `IgnoreHit`(不计分)—— 分全在嵌套部件上。
 * 我们的模型里没有"滑条本身"这个事件,所以不用处理。
 */
export function maxResultForPart(part: JudgementPart): LazerResult {
  switch (part) {
    case 'sliderTick':
    case 'sliderRepeat':
      return 'largeTickHit';
    case 'sliderTail':
      return 'sliderTailHit';
    default:
      // circle / sliderHead / spinner
      return 'great';
  }
}

/**
 * 把我们的 `(part, 判定档位)` 映射成 lazer 的 `(maxResult, type)`。
 *
 * 档位部件(circle / 头 / 转盘)直接按档位走;tick 类只有中/不中两态。
 */
export function lazerJudgementFor(part: JudgementPart, result: HitResult): LazerJudgement {
  const maxResult = maxResultForPart(part);

  if (maxResult === 'largeTickHit') {
    return { maxResult, type: result === HitResult.Miss ? 'largeTickMiss' : 'largeTickHit' };
  }

  if (maxResult === 'sliderTailHit') {
    // ⚠️ 末端漏掉是 ignoreMiss,不是 miss —— 所以不断 combo(见 affectsCombo)
    return { maxResult, type: result === HitResult.Miss ? 'ignoreMiss' : 'sliderTailHit' };
  }

  return { maxResult, type: basicResultOf(result) };
}

function basicResultOf(result: HitResult): LazerResult {
  switch (result) {
    case HitResult.Great:
      return 'great';
    case HitResult.Ok:
      return 'ok';
    case HitResult.Meh:
      return 'meh';
    default:
      return 'miss';
  }
}

/** 记分累加器的可变状态。字段名照 `ScoreProcessor` 的私有字段。 */
export interface LazerAccumulator {
  currentBaseScore: number;
  currentMaximumBaseScore: number;
  currentAccuracyJudgementCount: number;
  currentComboPortion: number;
  currentBonusPortion: number;
}

export function emptyAccumulator(): LazerAccumulator {
  return {
    currentBaseScore: 0,
    currentMaximumBaseScore: 0,
    currentAccuracyJudgementCount: 0,
    currentComboPortion: 0,
    currentBonusPortion: 0,
  };
}

/**
 * 累加一次判定。对应 `ScoreProcessor.ApplyResultInternal`。
 *
 * @param comboAfterJudgement 这次判定**之后**的 combo。
 *   ⚠️ 是"之后",与 stable 的"之前"相反 —— 源码是
 *   `Math.Pow(result.ComboAfterJudgement, COMBO_EXPONENT)`。
 */
export function applyJudgement(
  acc: LazerAccumulator,
  judgement: LazerJudgement,
  comboAfterJudgement: number,
): void {
  const { maxResult, type } = judgement;

  if (affectsAccuracy(maxResult)) {
    acc.currentMaximumBaseScore += baseScoreOf(maxResult);
    acc.currentAccuracyJudgementCount++;
  }

  if (affectsAccuracy(type)) {
    acc.currentBaseScore += baseScoreOf(type);
  }

  if (isBonus(type)) {
    acc.currentBonusPortion += baseScoreOf(type);
  } else if (isScorable(type)) {
    acc.currentComboPortion +=
      baseScoreOf(maxResult) * Math.pow(comboAfterJudgement, COMBO_EXPONENT);
  }
}

/** 一次完美通关的上限值。由 {@link lazerMaxima} 模拟得出。 */
export interface LazerMaxima {
  readonly maximumBaseScore: number;
  readonly maximumComboPortion: number;
  readonly maximumAccuracyJudgementCount: number;
}

/**
 * 模拟"完美走一遍"求出各项上限 —— 对应 `ScoreProcessor.Reset` 里跑的那次 autoplay。
 *
 * 必须**按时间顺序**走,因为 `comboPortion` 里的 `combo^0.5` 与顺序有关。
 *
 * ⚠️ 转盘的 bonus 刻度未建模,所以带转盘的图会偏 —— `bonusPortion` 是加在
 * 100 万之外的,漏掉它会让分数偏低。见 TECH-NOTES 的 lazer 记分条目。
 */
export function lazerMaxima(beatmap: SimBeatmap): LazerMaxima {
  interface Entry {
    readonly time: number;
    readonly objectIndex: number;
    readonly part: JudgementPart;
  }

  const entries: Entry[] = [];

  beatmap.hitObjects.forEach((object, objectIndex) => {
    if (object.kind === 'spinner') {
      entries.push({ time: object.endTime, objectIndex, part: 'spinner' });
      return;
    }

    if (object.kind === 'circle') {
      entries.push({ time: object.startTime, objectIndex, part: 'circle' });
      return;
    }

    entries.push({ time: object.startTime, objectIndex, part: 'sliderHead' });
    for (const p of object.parts) {
      entries.push({
        time: p.time,
        objectIndex,
        part:
          p.kind === 'tick' ? 'sliderTick'
          : p.kind === 'repeat' ? 'sliderRepeat'
          : 'sliderTail',
      });
    }
  });

  // 与判定器的排序规则保持一致(时间,然后物件下标)
  entries.sort((a, b) => a.time - b.time || a.objectIndex - b.objectIndex);

  const acc = emptyAccumulator();
  let combo = 0;

  for (const e of entries) {
    const maxResult = maxResultForPart(e.part);
    // 完美通关 ⇒ 实际结果就是 MaxResult
    if (increasesCombo(maxResult)) combo++;
    applyJudgement(acc, { maxResult, type: maxResult }, combo);
  }

  return {
    maximumBaseScore: acc.currentBaseScore,
    maximumComboPortion: acc.currentComboPortion,
    maximumAccuracyJudgementCount: acc.currentAccuracyJudgementCount,
  };
}

/**
 * `ScoreProcessor.ComputeTotalScore` + `updateScore` 的除法。
 *
 * @param modMultiplier mod 系数。lazer 的系数与 stable **不同**(见 M5),
 *   无 mod 时传 1
 */
export function lazerTotalScore(
  acc: LazerAccumulator,
  maxima: LazerMaxima,
  modMultiplier = 1,
): number {
  const accuracy =
    acc.currentMaximumBaseScore > 0 ? acc.currentBaseScore / acc.currentMaximumBaseScore : 1;

  const comboProgress =
    maxima.maximumComboPortion > 0 ? acc.currentComboPortion / maxima.maximumComboPortion : 1;

  const accuracyProgress =
    maxima.maximumAccuracyJudgementCount > 0
      ? acc.currentAccuracyJudgementCount / maxima.maximumAccuracyJudgementCount
      : 1;

  const withoutMods = Math.round(
    (MAX_SCORE / 2) * accuracy * comboProgress +
      (MAX_SCORE / 2) * Math.pow(accuracy, 5) * accuracyProgress +
      acc.currentBonusPortion,
  );

  return Math.round(withoutMods * modMultiplier);
}
