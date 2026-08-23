import { lastIndexAtOrBefore } from '../util/search';

/**
 * 回放帧的按键位域。
 *
 * 注意 osu!stable 的行为:按下 K1 时 **M1 也会被置位**,按下 K2 时 M2 同理。
 * 所以判断"这一帧按了几个键"不能直接数位数,必须先规范化。
 */
export const ReplayKey = {
  M1: 1 << 0,
  M2: 1 << 1,
  K1: 1 << 2,
  K2: 1 << 3,
  Smoke: 1 << 4,
} as const;

/** 只保留真正独立的两个键位,消除 stable 的 K1→M1 / K2→M2 冗余置位。 */
export function normalizeKeys(keys: number): number {
  let out = 0;
  if (keys & (ReplayKey.M1 | ReplayKey.K1)) out |= ReplayKey.M1;
  if (keys & (ReplayKey.M2 | ReplayKey.K2)) out |= ReplayKey.M2;
  return out;
}

/**
 * 回放帧,存成 SoA(structure of arrays)。
 *
 * 典型回放约 30000 帧。用对象数组会产生 30000 个 GC 对象;三块并行 TypedArray
 * 是连续内存,二分查找 cache 友好。见 TECH-NOTES C3。
 *
 * `time` 按**非严格**升序排列 —— 注意不是严格升序:真实回放里存在 `interval == 0`
 * 的零间隔帧,导致相邻帧时间戳相同(实测 4 个样本各有 16~69 对)。
 * 且这些重复对中**多数按键状态不同** —— 一次点击可以整个发生在零长度间隔内。
 *
 * ⚠️ **绝不能按时间戳去重**,那会直接丢掉按键。见 TECH-NOTES B6。
 */
export interface ReplayFrames {
  readonly count: number;
  /** 谱面时间(ms),非严格升序(允许相邻相等) */
  readonly time: Float64Array;
  /** osu! 坐标系(0..512) */
  readonly x: Float32Array;
  /** osu! 坐标系(0..384) */
  readonly y: Float32Array;
  readonly keys: Uint8Array;
}

export interface CursorSample {
  readonly x: number;
  readonly y: number;
  /** 未规范化的原始位域,需要时自行调 {@link normalizeKeys} */
  readonly keys: number;
  /** 对应的帧下标;-1 表示 t 早于第一帧 */
  readonly frameIndex: number;
}

/** stable 回放末尾的哨兵帧:time == -12345,承载 RNG seed 而非真实输入。必须剔除。 */
const SEED_FRAME_TIME = -12345;

export interface RawReplayFrame {
  /** 累积时间(ms)。osu-parsers 里字段名可能是 startTime。 */
  readonly startTime: number;
  readonly x: number;
  readonly y: number;
  /** 按键位域。osu-parsers 里字段名可能是 buttonState。 */
  readonly keys: number;
}

/**
 * 把解析器产出的帧对象数组转成 SoA。
 *
 * 会做两件容易漏的清理:
 * 1. 剔除 `time == -12345` 的 seed 哨兵帧(见 {@link SEED_FRAME_TIME})
 * 2. 按时间**稳定**排序 —— 不能假设解析器给的一定有序。稳定性在这里是硬要求:
 *    零间隔帧的时间戳相同,只有保序才能让"先 0 后 10"这样的按键序列不被打乱
 *    (JS 的 `Array.prototype.sort` 自 ES2019 起规定为稳定排序)。
 *
 * **不做**去重:相同时间戳的帧往往承载不同按键,去重会丢输入。
 */
export function buildReplayFrames(raw: readonly RawReplayFrame[]): ReplayFrames {
  const kept = raw.filter((f) => f.startTime !== SEED_FRAME_TIME && Number.isFinite(f.startTime));
  kept.sort((a, b) => a.startTime - b.startTime);

  const count = kept.length;
  const time = new Float64Array(count);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const keys = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const f = kept[i]!;
    time[i] = f.startTime;
    x[i] = f.x;
    y[i] = f.y;
    keys[i] = f.keys & 0xff;
  }

  return { count, time, x, y, keys };
}

export const EMPTY_FRAMES: ReplayFrames = {
  count: 0,
  time: new Float64Array(0),
  x: new Float32Array(0),
  y: new Float32Array(0),
  keys: new Uint8Array(0),
};

/**
 * 求 t 时刻的光标状态。O(log n)。
 *
 * 位置在相邻两帧之间**线性插值**;按键**不插值**,取 t 之前最后一帧的值
 * (按键是离散事件,插值没有意义且会造成幽灵点击)。
 */
export function cursorAt(frames: ReplayFrames, t: number): CursorSample {
  if (frames.count === 0) {
    return { x: 256, y: 192, keys: 0, frameIndex: -1 };
  }

  const i = lastIndexAtOrBefore(frames.time, frames.count, t);

  // t 早于第一帧:钉在第一帧位置,无按键。
  if (i < 0) {
    return { x: frames.x[0]!, y: frames.y[0]!, keys: 0, frameIndex: -1 };
  }

  // t 在最后一帧之后:钉在最后一帧。
  if (i >= frames.count - 1) {
    const last = frames.count - 1;
    return { x: frames.x[last]!, y: frames.y[last]!, keys: frames.keys[last]!, frameIndex: last };
  }

  const t0 = frames.time[i]!;
  const t1 = frames.time[i + 1]!;
  const span = t1 - t0;
  const f = span > 0 ? (t - t0) / span : 0;

  return {
    x: frames.x[i]! + (frames.x[i + 1]! - frames.x[i]!) * f,
    y: frames.y[i]! + (frames.y[i + 1]! - frames.y[i]!) * f,
    keys: frames.keys[i]!,
    frameIndex: i,
  };
}
