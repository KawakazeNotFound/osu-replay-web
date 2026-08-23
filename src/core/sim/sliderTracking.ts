import { ReplayKey, normalizeKeys, type ReplayFrames } from '../replay/frames';
import { lastIndexAtOrBefore } from '../util/search';
import { pathOffsetAt, timeProgressToPathProgress } from './sliderPath';
import type { SimHitObject } from './types';

/**
 * 滑条跟踪(tracking)。
 *
 * ## 来源
 *
 * 逐条对照 `ppy/osu` master 的
 * `osu.Game.Rulesets.Osu/Objects/Drawables/SliderInputManager.cs` 与
 * `DrawableSliderBall.cs`(2026-08-23 核对)。规则全文见 TECH-NOTES B15。
 *
 * ## 三处不能省的细节
 *
 * 1. **follow area 有滞回**:已在跟踪用 `radius × 2.4`,未跟踪必须进 `radius`
 *    小圈才能重新开始。省掉滞回会在边缘疯狂抖动。
 * 2. **位置比的是"理论曲线位置"**:`curvePositionAt(clamp(时间进度, 0, 1))`,
 *    不是绘制变换后的位置。比较用距离**平方**,且**含等号**。
 * 3. **"有效键"不是"任意键按住"**:命中滑条头的那个键是唯一跟踪键,
 *    直到观察到某一帧另一个键处于松开状态,之后两个键都算。
 *    lazer 注释说这防的是"滑条前预按住一个键 + 补点第二个键"的滥用。
 *
 * ## 与 lazer 的一处必然差异
 *
 * lazer **逐渲染帧**跟踪(`IRequireHighFrequencyMousePosition`,鼠标位置比
 * 显示帧率还密),我们**逐回放帧**(约 60~1000Hz)。光标边缘擦过 follow circle
 * 的瞬间可能判得不同 —— 这是 A2 剩余偏差的嫌疑点之一。
 */

/** `DrawableSliderBall.FOLLOW_AREA`。乘的是**物件半径**,不是绘制尺寸。 */
export const FOLLOW_AREA = 2.4;

/** follow 圈半径。`expanded` 表示"当前是否正在跟踪"—— 这就是滞回。 */
export function followRadius(objectRadius: number, expanded: boolean): number {
  return expanded ? objectRadius * FOLLOW_AREA : objectRadius;
}

/**
 * 滑条球在 `t` 时刻的位置(已含堆叠偏移)。
 *
 * `followProgress` 被钳到 `[0, 1]`,所以滑条开始前/结束后用的是头/尾的位置。
 */
export function sliderBallAt(
  slider: SimHitObject,
  t: number,
): { readonly x: number; readonly y: number } {
  const duration = slider.endTime - slider.startTime;

  const followProgress =
    duration > 0 ? clamp01((t - slider.startTime) / duration) : t < slider.startTime ? 0 : 1;

  const pathProgress = timeProgressToPathProgress(followProgress, slider.spans);
  const offset = pathOffsetAt(slider.path, pathProgress);

  // path 存的是相对起点的偏移;加到**堆叠后**的位置上
  return { x: slider.stackedX + offset.x, y: slider.stackedY + offset.y };
}

/** 跟踪状态机。一条滑条一个实例,按时间单向推进。 */
export class SliderTracker {
  private readonly slider: SimHitObject;
  private readonly frames: ReplayFrames;
  private readonly objectRadius: number;

  /** 命中滑条头的键(规范化后的位:`ReplayKey.M1` 或 `M2`)。0 = 头未命中 */
  private headKey = 0;

  /**
   * 从哪一刻起"任意键"都可以跟踪。`null` = 仍受 {@link headKey} 限制。
   *
   * lazer 特意存**时刻**而不是布尔值,为的是正确处理回退。我们不回退,
   * 但保持同样的语义便于对照源码。
   */
  private acceptAnyKeyAfter: number | null = null;

  /** 上一帧按住的键,用于判断"另一个键是否已松开"。 */
  private lastKeys = 0;

  /** 当前是否在跟踪。follow area 的滞回依赖它。 */
  private tracking = false;

  constructor(slider: SimHitObject, frames: ReplayFrames, objectRadius: number) {
    this.slider = slider;
    this.frames = frames;
    this.objectRadius = objectRadius;
  }

  /**
   * 告知滑条头的判定结果。
   *
   * @param key 命中滑条头的键(规范化位域)。0 表示头没命中
   */
  setHeadResult(key: number): void {
    this.headKey = key;
    if (key === 0) this.acceptAnyKeyAfter = null;
  }

  get isTracking(): boolean {
    return this.tracking;
  }

  /**
   * 推进到 `t` 时刻并返回是否在跟踪。
   *
   * 必须按时间**单调**调用 —— 内部状态(`acceptAnyKeyAfter` / `lastKeys` / 滞回)
   * 依赖顺序。判定器是顺序扫描的,满足这个前提。
   */
  advanceTo(t: number): boolean {
    const frameIndex = lastIndexAtOrBefore(this.frames.time, this.frames.count, t);

    // 还没有任何回放帧 → 谈不上按键
    if (frameIndex < 0) {
      this.tracking = false;
      this.lastKeys = 0;
      return false;
    }

    const keys = normalizeKeys(this.frames.keys[frameIndex]!);

    // ---- "任意键"解锁的维护(对应 lazer updateTracking 里那段) ----
    if (this.headKey === 0) {
      this.acceptAnyKeyAfter = null;
    } else if (this.acceptAnyKeyAfter === null) {
      const otherKey = this.headKey === ReplayKey.M1 ? ReplayKey.M2 : ReplayKey.M1;
      // 上一帧另一个键没被按住 → 从此刻起两个键都能跟踪
      if ((this.lastKeys & otherKey) === 0) this.acceptAnyKeyAfter = t;
    }

    const validAction = this.isValidTrackingKey(keys, t);

    // ---- 位置:滞回用**当前**跟踪状态决定圈的大小 ----
    const inFollowArea = this.isCursorInFollowArea(t, frameIndex, this.tracking);

    // 时间闸门:超过滑条末尾就不再跟踪
    const withinTime = t <= this.slider.endTime;

    this.tracking = withinTime && inFollowArea && validAction;
    this.lastKeys = keys;

    return this.tracking;
  }

  /**
   * 光标是否在 follow area 内。
   *
   * 用**帧自身**的坐标而不是插值 —— 与判定里"按下用帧坐标"一致:
   * 插值会得到玩家从未处于过的位置。
   */
  private isCursorInFollowArea(t: number, frameIndex: number, expanded: boolean): boolean {
    const ball = sliderBallAt(this.slider, t);
    const radius = followRadius(this.objectRadius, expanded);

    const dx = this.frames.x[frameIndex]! - ball.x;
    const dy = this.frames.y[frameIndex]! - ball.y;

    // 平方比较,含等号(lazer 是 `<= radius * radius`)
    return dx * dx + dy * dy <= radius * radius;
  }

  /**
   * 按的键是否算有效。
   *
   * 头未命中时任意键都算(此时 `headKey === 0`);头已命中且尚未解锁时,
   * 只有命中头的那个键算。
   */
  private isValidTrackingKey(keys: number, t: number): boolean {
    if (keys === 0) return false;

    const restricted =
      this.headKey !== 0 && (this.acceptAnyKeyAfter === null || t <= this.acceptAnyKeyAfter);

    return restricted ? (keys & this.headKey) !== 0 : true;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
