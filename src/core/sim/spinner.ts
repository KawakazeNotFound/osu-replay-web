import { normalizeKeys, type ReplayFrames } from '../replay/frames';
import { difficultyRange } from './difficulty';
import { firstIndexAtOrAfter } from '../util/search';
import { HitResult, type SimHitObject } from './types';

/**
 * 转盘判定。
 *
 * ## 与 circle / slider 的根本不同
 *
 * 转盘不靠"点中",靠**转够圈数**。所以判定方式是:统计玩家在转盘时间范围内
 * 绕中心累积转过多少角度,与"要求圈数"比。
 *
 * ## 要求圈数
 *
 * 每秒要求的转数由 OD 决定 —— lazer `Spinner.ApplyDefaultsToSelf`:
 * ```
 * SpinsRequired = duration / 1000 * SpinsPerSecond
 * SpinsPerSecond = difficultyRange(OD, 3, 5, 7.5)
 * ```
 *
 * ## 判定阈值(stable)
 *
 * | 完成度 | 结果 |
 * |---|---|
 * | ≥ 1 | 300 |
 * | ≥ 0.9 | 100 |
 * | ≥ 0.75 | 50 |
 * | 其余 | miss |
 *
 * ## ⚠️ 已知近似
 *
 * 1. **逐回放帧累积角度**,而 osu 是逐渲染帧。回放帧率低时快速旋转会少算 ——
 *    但转盘通常远超要求圈数,余量很大。
 * 2. **没有建模"必须按住键"的严格性**:这里要求该帧有键按住才累积角度,
 *    但 osu 的转盘在松手瞬间的处理更细。
 * 3. **不算 bonus**(转超要求后的额外分)。那只影响分数,不影响 300/100/50。
 * 4. 单帧角度变化超过 π 时按"没有跨越"处理 —— 逐帧转半圈以上说明采样不足,
 *    此时无法区分方向,忽略比瞎猜安全。
 */

/** 转盘中心。osu 的转盘恒在判定区正中。 */
const SPINNER_CENTER_X = 256;
const SPINNER_CENTER_Y = 192;

/** 每秒要求转数。lazer:`difficultyRange(OD, 3, 5, 7.5)`。 */
export function spinsPerSecondFor(overallDifficulty: number): number {
  return difficultyRange(overallDifficulty, 3, 5, 7.5);
}

/** 整个转盘要求的转数。 */
export function spinsRequiredFor(durationMs: number, overallDifficulty: number): number {
  return (durationMs / 1000) * spinsPerSecondFor(overallDifficulty);
}

/** 完成度 → 判定结果。 */
export function spinnerResultFor(completion: number): HitResult {
  if (completion >= 1) return HitResult.Great;
  if (completion >= 0.9) return HitResult.Ok;
  if (completion >= 0.75) return HitResult.Meh;
  return HitResult.Miss;
}

/**
 * 统计玩家在转盘期间累积转过的圈数。
 *
 * 逐帧求光标相对中心的角度变化并累加**绝对值** —— 方向不重要,osu 两个方向
 * 都算(玩家中途反向会损失,但那是真实损失)。
 *
 * 只在**有键按住**的帧累积。
 */
export function countSpins(
  spinner: SimHitObject,
  frames: ReplayFrames,
): number {
  let index = firstIndexAtOrAfter(frames.time, frames.count, spinner.startTime);
  if (index >= frames.count) return 0;

  let totalRadians = 0;
  let previousAngle: number | null = null;

  while (index < frames.count && frames.time[index]! <= spinner.endTime) {
    const held = normalizeKeys(frames.keys[index]!) !== 0;

    if (!held) {
      // 松手 → 断开连续性,下一帧重新起算
      previousAngle = null;
      index++;
      continue;
    }

    const angle = Math.atan2(
      frames.y[index]! - SPINNER_CENTER_Y,
      frames.x[index]! - SPINNER_CENTER_X,
    );

    if (previousAngle !== null) {
      let delta = angle - previousAngle;

      // 绕回归一到 (-π, π]
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta <= -Math.PI) delta += 2 * Math.PI;

      totalRadians += Math.abs(delta);
    }

    previousAngle = angle;
    index++;
  }

  return totalRadians / (2 * Math.PI);
}

/** 判定一个转盘。 */
export function judgeSpinner(
  spinner: SimHitObject,
  frames: ReplayFrames,
  overallDifficulty: number,
): { readonly result: HitResult; readonly spins: number; readonly required: number } {
  const duration = Math.max(0, spinner.endTime - spinner.startTime);
  const required = spinsRequiredFor(duration, overallDifficulty);
  const spins = countSpins(spinner, frames);

  // 要求为 0(零长度转盘)时视为完成 —— 否则会除零
  const completion = required <= 0 ? 1 : spins / required;

  return { result: spinnerResultFor(completion), spins, required };
}
