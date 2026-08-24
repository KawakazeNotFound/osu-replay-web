import { timeProgressToPathProgress } from '../core/sim/sliderPath';
import type { SimHitObject } from '../core/sim/types';

/**
 * # 滑条 snaking(伸展与收缩)
 *
 * 用户实测报的两个问题:
 * 1. 滑条一出现就把**整条路径**画出来了 —— 应该从头部**伸展**到尾部
 * 2. 滑条球划过之后路径不消失 —— 应该在球后面**收缩**掉,
 *    而 repeat 滑条要**等最后一次重复之后**才抹除
 *
 * 两条都对应 lazer 的 `SnakingSliderBody.UpdateProgress`。
 *
 * ## 源码(`osu.Game.Rulesets.Osu/Skinning/SnakingSliderBody.cs:73-100`,2026-08-24 核)
 *
 * ```csharp
 * int span = slider.SpanAt(completionProgress);
 * double spanProgress = slider.ProgressAt(completionProgress);
 *
 * double start = 0;
 * double end = SnakingIn.Value
 *     ? Math.Clamp((Time.Current - (slider.StartTime - slider.TimePreempt)) / (slider.TimePreempt / 3), 0, 1)
 *     : 1;
 *
 * if (span >= slider.SpanCount() - 1)
 * {
 *     if (Math.Min(span, slider.SpanCount() - 1) % 2 == 1)
 *     {
 *         start = 0;
 *         end = SnakingOut.Value ? spanProgress : 1;
 *     }
 *     else
 *     {
 *         start = SnakingOut.Value ? spanProgress : 0;
 *     }
 * }
 *
 * setRange(start, end);
 * ```
 *
 * 配合(`IHasPathWithRepeats.cs` / `IHasRepeats.cs`):
 * ```csharp
 * SpanAt(p)     => (int)(p * SpanCount())
 * ProgressAt(p) => { double q = p * SpanCount() % 1; if (SpanAt(p) % 2 == 1) q = 1 - q; return q; }
 * SpanCount()   => RepeatCount + 1
 * ```
 *
 * ## 三个容易写错的点
 *
 * 1. **伸展时长是 `preempt / 3`,不是 `preempt`。** 起点在 `startTime - preempt`,
 *    所以滑条在出现后的**前三分之一**就伸完,剩下三分之二是完整路径在等着被点。
 *    用整个 preempt 会让伸展慢得很明显。webosu 用的也是 `approachTime / 3`。
 *
 * 2. **收缩只发生在最后一个 span**(`span >= SpanCount - 1`)。这正是"repeat 滑条
 *    要等最后一次重复之后才抹除"—— 中间那些来回不收缩,否则路径会反复消失重现。
 *
 * 3. **`ProgressAt` 自带奇偶反转**(`q = 1 - q`),所以反向 span 上 `spanProgress`
 *    是从 1 降到 0 的。这让"奇 span → `[0, spanProgress]`"自然表现为**向头部收缩**,
 *    不需要再翻一次符号。自己实现 `ProgressAt` 时漏掉这条,方向就会反。
 *
 * ## 默认开关
 *
 * `OsuRulesetConfigManager`:`SnakingInSliders` 与 `SnakingOutSliders` **默认都是 `true`**。
 * 所以这是 lazer 的默认观感,不是可选特效。留出开关只是为了将来做播放器设置。
 */

export interface SnakingOptions {
  /** 伸展。lazer 默认 true */
  readonly snakingIn: boolean;
  /** 收缩。lazer 默认 true */
  readonly snakingOut: boolean;
}

export const DEFAULT_SNAKING: SnakingOptions = { snakingIn: true, snakingOut: true };

/**
 * 当前应该画出的路径区间,单位是**单个 span 的路径进度**(0..1)。
 *
 * `visible === false` 表示这一刻整条滑条体都不该画(收缩完毕)。
 */
export interface SnakeRange {
  readonly from: number;
  readonly to: number;
  readonly visible: boolean;
}

/** 区间短于这个长度就当作不可见 —— 再短也只会画出一个圆点。 */
const MIN_VISIBLE_SPAN = 1e-6;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 求某时刻的 snaking 区间。
 *
 * @param preempt 该谱面的 `TimePreempt`(ms)—— 伸展窗口是它的三分之一
 */
export function snakeRangeAt(
  object: SimHitObject,
  time: number,
  preempt: number,
  options: SnakingOptions = DEFAULT_SNAKING,
): SnakeRange {
  const spans = Math.max(1, object.spans);
  // 退化滑条(endTime <= startTime)不能拿来做除数
  const duration = Math.max(1e-9, object.endTime - object.startTime);
  const completion = clamp01((time - object.startTime) / duration);

  // ⚠️ completion === 1 时 span 会等于 spans(越界一格)—— 源码正是靠下面的
  // Math.min 收住的,所以这里刻意不夹
  const span = Math.floor(completion * spans);
  const spanProgress = timeProgressToPathProgress(completion, spans);

  let from = 0;
  // preempt 实际最小 450(AR10),但除法还是兜一下
  const snakeInWindow = Math.max(1e-9, preempt / 3);
  let to = options.snakingIn
    ? clamp01((time - (object.startTime - preempt)) / snakeInWindow)
    : 1;

  if (span >= spans - 1) {
    if (Math.min(span, spans - 1) % 2 === 1) {
      from = 0;
      to = options.snakingOut ? spanProgress : 1;
    } else {
      from = options.snakingOut ? spanProgress : 0;
    }
  }

  // 源码 `setRange` 的第一件事就是 `if (p0 > p1) (p0, p1) = (p1, p0);`。
  // 什么时候会反?**极短的滑条** —— 收缩已经推进(from 变大),而伸展还没走完
  // (to 仍然很小)。照搬这次交换,不自作聪明改成"当作空区间"
  if (from > to) [from, to] = [to, from];

  return { from, to, visible: to - from > MIN_VISIBLE_SPAN };
}
