import { PREEMPT_MIN } from '../core/sim/difficulty';

/**
 * # approach circle 的时间线
 *
 * 我们原来的实现是"从 4 倍半径**线性**缩到 1 倍",数字是我随手定的。
 * 核过源码后:**4 与线性都对**,但"1 倍"的基准写错了,而且 alpha 完全没做。
 *
 * ## 缩放(核 `DrawableHitCircle.cs:89-96, 190-199`)
 *
 * ```csharp
 * ApproachCircle = new ProxyableSkinnableDrawable(...)
 * {
 *     Alpha = 0,
 *     Scale = new Vector2(4),
 * }
 * ...
 * ApproachCircle.FadeTo(0.9f, Math.Min(HitObject.TimeFadeIn * 2, HitObject.TimePreempt));
 * ApproachCircle.ScaleTo(1f, HitObject.TimePreempt);
 * ```
 *
 * `ScaleTo` 的默认 easing 是 `Easing.None`(`TransformableExtensions.cs:355`)⇒ **线性**。
 * 起点时刻是 `HitObject.StartTime - InitialLifetimeOffset`,而
 * `DrawableOsuHitObject.cs:124` 给出 `InitialLifetimeOffset => HitObject.TimePreempt`。
 *
 * ### ⚠️ "1 倍"是**贴图自己的显示尺寸**,不是 `2 × Radius`
 *
 * `ScaleTo(1)` 缩的是那个 `Scale = 4` 的**包装容器**;里面的 Sprite 是贴图原生显示
 * 尺寸,legacy 下**不再乘任何系数**。所以终点直径 =
 * `approachcircle 贴图 display 宽 × HitObject.Scale`。
 *
 * 二者相等**只在** `approachcircle.png` 与 `hitcircle.png` 像素尺寸相同时成立
 * —— stable 皮肤惯例上确实相同,所以"写成 2×Radius"多数时候看不出差别,
 * 但那是碰巧,不是规则。
 *
 * ### ⚠️ legacy **没有** `128 / 118`
 *
 * ```csharp
 * // DefaultApproachCircle.cs:28-31 —— 这是**非** legacy 皮肤的分支
 * // In triangles and argon skins, we expanded hitcircles to take up the full 128 px
 * // which are clickable, but still use the old approach circle sprite. To make it feel
 * // correct ... we need to expand it slightly.
 * Scale = new Vector2(128 / 118f);
 * ```
 * 这个 `128/118` 只属于 Argon/Triangles。抄到 legacy 上会让圈大 8.5%。
 *
 * ## alpha
 *
 * 三段:
 * 1. `ST - TP` 起,over `min(2 × TimeFadeIn, TP)` 从 0 线性到 **0.9**(不是 1)
 * 2. `ST` 时刻 `FadeOut(50)` —— 源码注释:*"always fade out at the circle's start
 *    time (to match user expectations)"*
 * 3. 判定时刻(`HitStateUpdateTime`)立刻消失(`FadeOut()` 无时长)
 *
 * 注意第 3 条:`ArmedState.Miss` 走自己的 case、**不执行** `ApproachCircle.FadeOut()`,
 * 但第 2 条已经在 `ST` 就把它带走了(miss 窗口是 400ms,远晚于 ST+50)。
 * 所以实现上"判定即消失"对 hit 与 miss 都成立。
 */

/** 构造时的初始缩放。核 `DrawableHitCircle.cs:95`:`Scale = new Vector2(4)`。 */
export const APPROACH_START_SCALE = 4;

/** `ST` 时刻的淡出时长。核 `DrawableHitCircle.cs:206`:`ApproachCircle.FadeOut(50)`。 */
export const APPROACH_FADE_OUT_MS = 50;

/** 淡入的目标不透明度 —— **0.9,不是 1**。核 `DrawableHitCircle.cs:196`。 */
export const APPROACH_PEAK_ALPHA = 0.9;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * approach circle 的缩放倍数(相对贴图自身显示尺寸)。
 *
 * @param preempt `TimePreempt`
 */
export function approachScaleAt(startTime: number, preempt: number, time: number): number {
  const progress = clamp01((time - (startTime - preempt)) / Math.max(1e-9, preempt));
  return APPROACH_START_SCALE + (1 - APPROACH_START_SCALE) * progress;
}

/**
 * approach circle 的不透明度。
 *
 * @param hitTime 该物件的判定时刻(`Result.TimeAbsolute`);`null` = 尚未判定
 */
export function approachAlphaAt(
  startTime: number,
  preempt: number,
  time: number,
  hitTime: number | null,
): number {
  // 判定即消失(FadeOut() 无时长)
  if (hitTime !== null && time >= hitTime) return 0;

  const appear = startTime - preempt;
  if (time < appear) return 0;

  if (time < startTime) {
    // TimeFadeIn = 400 * min(1, TimePreempt / PREEMPT_MIN)
    const fadeIn = 400 * Math.min(1, preempt / PREEMPT_MIN);
    const window = Math.max(1e-9, Math.min(fadeIn * 2, preempt));
    return APPROACH_PEAK_ALPHA * clamp01((time - appear) / window);
  }

  const since = time - startTime;
  if (since < APPROACH_FADE_OUT_MS) {
    return APPROACH_PEAK_ALPHA * (1 - since / APPROACH_FADE_OUT_MS);
  }

  return 0;
}
