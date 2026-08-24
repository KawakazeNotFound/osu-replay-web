/**
 * 滑条路径的采样表示。
 *
 * ## 为什么需要它
 *
 * 滑条跟踪(见 TECH-NOTES B15)要比较**光标与滑条球的距离**,而球位置是
 * `curvePositionAt(时间进度)` —— 需要在**任意时刻**求路径上的点。
 *
 * 但 `SimBeatmap` 与解析层是解耦的(架构决策,见 ARCHITECTURE),拿不到
 * osu-classes 的 `SliderPath`。所以在 loader 里把路径**采样**成折线存下来,
 * 判定与渲染都用它。M2 画滑条体同样需要这份折线,不算浪费。
 *
 * ## 采样精度
 *
 * 按 {@link SAMPLE_SPACING} 的目标间距取点,并夹在 {@link MIN_SAMPLES} 与
 * {@link MAX_SAMPLES} 之间。折线上做线性插值,误差量级远小于 follow circle
 * 的半径(最小的 CS 10 圈半径约 9.6,放大后约 23),所以对判定结论无影响。
 */

/** 采样目标间距(osu 单位)。 */
const SAMPLE_SPACING = 2;

/** 最少采样点。极短滑条也要有起点与终点之外的余量。 */
const MIN_SAMPLES = 16;

/** 最多采样点。防超长滑条把内存吃掉(实测最长的路径 1020 单位 → 511 点)。 */
const MAX_SAMPLES = 1024;

/**
 * 采样后的滑条路径。
 *
 * SoA 存储:与回放帧同样的理由 —— 340 条滑条 × 几十个点,对象数组会造出上万个
 * GC 对象。
 */
export interface SliderPathSamples {
  /** 采样点数 */
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
}

/** 空路径,给 circle / spinner 用。 */
export const EMPTY_PATH: SliderPathSamples = {
  count: 0,
  x: new Float32Array(0),
  y: new Float32Array(0),
};

/**
 * 按路径长度决定采样点数。
 *
 * 导出是为了让测试能独立验算,不必反推实现。
 */
export function sampleCountFor(pathDistance: number): number {
  if (!Number.isFinite(pathDistance) || pathDistance <= 0) return MIN_SAMPLES;

  const wanted = Math.ceil(pathDistance / SAMPLE_SPACING) + 1;
  return Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, wanted));
}

/**
 * 把 `positionAt(progress)` 采样成折线。
 *
 * `positionAt` 由调用方(loader)提供 —— 它是 osu-classes `SliderPath` 的方法,
 * 返回**相对滑条起点**的偏移。这里原样存偏移,加上物件位置的事交给取值时做,
 * 这样堆叠偏移不必重新采样。
 */
export function samplePath(
  pathDistance: number,
  positionAt: (progress: number) => { readonly x: number; readonly y: number },
): SliderPathSamples {
  const count = sampleCountFor(pathDistance);
  const x = new Float32Array(count);
  const y = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const point = positionAt(i / (count - 1));
    x[i] = point.x;
    y[i] = point.y;
  }

  return { count, x, y };
}

/**
 * 求路径进度 `progress`(0..1)处的偏移。折线上线性插值。
 *
 * ⚠️ 按**采样下标**均匀插值,而不是按弧长 —— 因为采样本身就是按均匀 progress
 * 取的,所以这与 `positionAt` 的语义一致。
 */
export function pathOffsetAt(
  samples: SliderPathSamples,
  progress: number,
): { readonly x: number; readonly y: number } {
  if (samples.count === 0) return { x: 0, y: 0 };
  if (samples.count === 1) return { x: samples.x[0]!, y: samples.y[0]! };

  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  const scaled = p * (samples.count - 1);

  const i = Math.floor(scaled);
  if (i >= samples.count - 1) {
    const last = samples.count - 1;
    return { x: samples.x[last]!, y: samples.y[last]! };
  }

  const f = scaled - i;
  return {
    x: samples.x[i]! + (samples.x[i + 1]! - samples.x[i]!) * f,
    y: samples.y[i]! + (samples.y[i + 1]! - samples.y[i]!) * f,
  };
}

/**
 * 时间进度 → 路径进度,处理 repeat 的往复。
 *
 * 对应 osu-classes 的 `SliderPath.progressAt(progress, spans)`,也对应 lazer 的
 * `IHasPathWithRepeats.ProgressAt`(2026-08-24 核):
 * ```csharp
 * double p = progress * obj.SpanCount() % 1;
 * if (obj.SpanAt(progress) % 2 == 1)
 *     p = 1 - p;
 * ```
 *
 * ⚠️ 注意那个 `p = 1 - p`:**反向 span 上返回值是从 1 递减到 0 的**。
 * 滑条 snaking 依赖这一点(见 `render/sliderSnaking.ts`)—— 自己实现时若漏了
 * 这次反转,repeat 滑条的收缩方向就会反。
 *
 * 边界:`progress === 1` 时 `p` 会算成 0,但此时应取该 span 的末端。
 * 偶数 spans 结束于起点(0),奇数 spans 结束于末端(1) —— 与
 * `SliderEventGenerator` 给 Tail 事件的 `PathProgress = spans % 2` 一致。
 */
export function timeProgressToPathProgress(progress: number, spans: number): number {
  const total = Math.max(1, spans);
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;

  if (clamped >= 1) return total % 2 === 0 ? 0 : 1;

  const scaled = clamped * total;
  const within = scaled % 1;

  return Math.floor(scaled) % 2 === 1 ? 1 - within : within;
}

/**
 * 落在开区间 `(from, to)` 内的采样点下标范围。
 *
 * 给滑条 snaking 用:只画路径的一段时,需要"两个精确插值端点 + 中间的原始采样点"。
 * 端点单独用 {@link pathOffsetAt} 求,这个函数负责中间那一段。
 *
 * 返回 `first > last` 表示区间内**没有**采样点(极短的一段),此时调用方只连两个端点。
 *
 * ⚠️ 刻意返回下标而不是新建数组:snaking 每帧都在变,每条滑条每帧建一个数组
 * 会造出大量短命对象。调用方直接按下标读 SoA 即可。
 */
export function pathRangeBounds(
  samples: SliderPathSamples,
  from: number,
  to: number,
): { readonly first: number; readonly last: number } {
  const n = samples.count;
  if (n < 2) return { first: 1, last: 0 };

  // 采样点 i 位于进度 i * step —— 采样是按均匀 progress 取的,见 samplePath()
  const step = 1 / (n - 1);

  // 严格大于 from 的最小下标 / 严格小于 to 的最大下标。
  // 用 floor(x)+1 与 ceil(x)-1 而不是 ceil/floor,是为了在 x 恰为整数时也保持严格
  // (端点本身由 pathOffsetAt 精确给出,重复连一次会产生零长度线段)
  const first = Math.max(0, Math.floor(from / step) + 1);
  const last = Math.min(n - 1, Math.ceil(to / step) - 1);

  return { first, last };
}
