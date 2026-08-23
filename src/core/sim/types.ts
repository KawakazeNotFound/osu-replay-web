import type { CursorSample, ReplayFrames } from '../replay/frames';

/**
 * 判定结果。
 *
 * 数值不对应任何文件格式,仅内部使用。lazer 的判定种类比 stable 多
 * (large/small tick、slider tail 等),这里先按 lazer 的粒度定义,
 * stable 判定映射到其子集。
 */
export enum HitResult {
  None = 0,
  Miss,
  Meh,
  Ok,
  Great,
  /** 滑条重复点 / 滑条尾等"大刻度" */
  LargeTickHit,
  LargeTickMiss,
  /** 滑条刻度等"小刻度" */
  SmallTickHit,
  SmallTickMiss,
  /** 转盘的额外旋转 */
  SpinnerBonus,
}

/** 判定归属到物件的哪个部分。滑条一个物件会产生多条判定。 */
export type JudgementPart =
  | 'circle'
  | 'sliderHead'
  | 'sliderTick'
  | 'sliderRepeat'
  | 'sliderTail'
  | 'spinner'
  | 'spinnerBonus';

export type HitObjectKind = 'circle' | 'slider' | 'spinner';

/**
 * 模拟层需要的物件信息。
 *
 * 刻意**不**直接用 osu-classes 的类型 —— 模拟层与解析层解耦,这样
 * 换解析器(或自己写解析器,见 TECH-NOTES A1)不会波及模拟与渲染。
 * 适配器在 `src/core/load/` 里。
 */
export interface SimHitObject {
  readonly kind: HitObjectKind;
  readonly startTime: number;
  /** circle 上等于 startTime;slider / spinner 上是结束时刻 */
  readonly endTime: number;
  /**
   * osu! 坐标系(0..512)。**未堆叠**的原始坐标。
   *
   * 渲染与判定都应该用 {@link stackedX} —— 这里保留原始值是为了可调试
   * (对照 `.osu` 文件能直接看出来),与 lazer 保留 `Position` 与
   * `StackedPosition` 两者的做法一致。
   */
  readonly x: number;
  /** osu! 坐标系(0..384)。同 {@link x},未堆叠。 */
  readonly y: number;

  /**
   * 物件末端位置(未堆叠)。circle / spinner 上等于起点。
   *
   * slider 上是**路径末端**,且**考虑 repeat** —— 偶数 span 的滑条末端会回到
   * 起点(来回一趟)。堆叠算法要用它(圈叠在滑条尾上时是负向偏移)。
   */
  readonly endX: number;
  readonly endY: number;

  /**
   * 堆叠层数。0 = 不堆叠;可以为**负数**(圈叠在滑条尾上时往右下偏)。
   *
   * 由 `computeStackHeights()` 算出,见 `sim/stacking.ts`。
   */
  readonly stackHeight: number;
  /** 堆叠后的实际位置 = {@link x} + stackHeight * scale * -6.4。渲染与判定用这个。 */
  readonly stackedX: number;
  readonly stackedY: number;

  /** 滑条的 span 数(= repeat + 1)。circle / spinner 恒为 1。 */
  readonly spans: number;

  readonly newCombo: boolean;
  /** 第几个 combo(用于取 combo colour) */
  readonly comboIndex: number;
  /** combo 内的序号,从 1 开始(用于画圈内数字) */
  readonly indexInCombo: number;
}

export interface BreakPeriod {
  readonly start: number;
  readonly end: number;
}

export interface Difficulty {
  readonly circleSize: number;
  readonly approachRate: number;
  readonly overallDifficulty: number;
  readonly drainRate: number;
  readonly sliderMultiplier: number;
  readonly sliderTickRate: number;
}

export interface SimBeatmap {
  readonly hitObjects: readonly SimHitObject[];
  readonly breaks: readonly BreakPeriod[];
  readonly difficulty: Difficulty;
  /** 谱面 AudioLeadIn(ms) */
  readonly audioLeadIn: number;
  /**
   * 堆叠宽容度(`.osu` 的 StackLeniency,典型 0.2~0.7)。
   *
   * 用于计算堆叠阈值:`stackThreshold = (int)timePreempt * stackLeniency`。
   * ⚠️ 堆叠本身**尚未实现**,见 {@link SimHitObject} 上的说明。
   */
  readonly stackLeniency: number;
}

/** 某个事件生效**之后**的累积状态。这是 `stateAt` 能做到 O(log n) 的全部原因。 */
export interface CumulativeState {
  readonly score: number;
  readonly combo: number;
  readonly maxCombo: number;
  readonly countGreat: number;
  readonly countOk: number;
  readonly countMeh: number;
  readonly countMiss: number;
  /** 0..1。仅为该事件时刻的值,事件之间的被动流失由 {@link DrainProfile} 负责 */
  readonly hp: number;
}

export const ZERO_CUMULATIVE: CumulativeState = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  countGreat: 0,
  countOk: 0,
  countMeh: 0,
  countMiss: 0,
  hp: 1,
};

export interface JudgementEvent {
  /** 判定发生的时刻(ms)。注意不等于物件的 startTime。 */
  readonly time: number;
  readonly objectIndex: number;
  readonly part: JudgementPart;
  readonly result: HitResult;
  readonly cum: CumulativeState;
}

/** 物件的最终判定摘要,渲染层用来决定画命中动画还是 miss 动画。 */
export interface ObjectResult {
  readonly objectIndex: number;
  readonly result: HitResult;
  /** 实际命中时刻;null 表示未命中(miss) */
  readonly hitTime: number | null;
}

/**
 * 视觉窗口索引。按 `visualStart` 升序排列。
 *
 * `activeAt(t)` 靠二分 + 有界回溯实现,不扫全表,也不依赖"上一帧渲染了什么"
 * —— 后者会让 scrub 出现"只在顺序播放时正确"的 bug。
 */
export interface VisualIndex {
  /** 按 visualStart 升序的物件下标 */
  readonly order: Int32Array;
  /** 与 order 同序 */
  readonly visualStart: Float64Array;
  /** 与 order 同序 */
  readonly visualEnd: Float64Array;
  /** 所有物件中最长的视觉窗口时长,用于界定回溯范围 */
  readonly maxVisualDuration: number;
}

/**
 * HP 被动流失的分段描述。
 *
 * HP 同时受离散判定事件和连续被动流失影响,且流失**仅在 drain section 内生效**
 * —— break 区间不流失,第一个物件之前不流失。所以不能简单写成
 * `hp - rate * (t - lastEventTime)`,必须扣掉区间内的 break 时长。
 *
 * 这是最容易写错且最难发现的一处:顺序播放时误差会被后续事件"纠正"掉,
 * 只有 scrub 到 break 中间才暴露。见 TECH-NOTES D1。
 */
export interface DrainProfile {
  /** drain 生效区间的起点,升序 */
  readonly segStart: Float64Array;
  /** drain 生效区间的终点,与 segStart 同序 */
  readonly segEnd: Float64Array;
  /** 前缀和:到 segStart[i] 之前累积的**有效流失时长**(ms) */
  readonly cumDrainedMs: Float64Array;
  /** 每 ms 流失的 HP 量(0..1 标度) */
  readonly drainPerMs: number;
}

/**
 * 编译后的回放时间线 —— 不可变。
 *
 * 由 `buildTimeline()` 在加载时一次性产出。之后所有查询都是纯读,
 * 不跑任何模拟。mod / 谱面变更需要重建整条时间线(成本 <100ms)。
 *
 * 见 ARCHITECTURE.md 第 1 节。
 */
export interface ReplayTimeline {
  readonly beatmap: SimBeatmap;
  readonly frames: ReplayFrames;

  /** 按时间升序 */
  readonly events: readonly JudgementEvent[];
  /** events 的时间投影,单独存一份 Float64Array 以便二分 */
  readonly eventTimes: Float64Array;

  /** 按物件下标索引;null 表示该物件还没有判定记录 */
  readonly objectResults: readonly (ObjectResult | null)[];

  readonly visual: VisualIndex;
  readonly drain: DrainProfile;

  /** 时间轴可播放范围(含 lead-in 与尾部余量) */
  readonly startTime: number;
  readonly endTime: number;

  /** 物件总数,用于算准确率分母 */
  readonly maxJudgeableObjects: number;
}

export interface ActiveObject {
  readonly index: number;
  readonly object: SimHitObject;
  readonly result: ObjectResult | null;
}

/**
 * 某一时刻的完整播放状态 —— 渲染层的唯一输入。
 *
 * 每帧新建一个。渲染层**不得**持有跨帧的可变游戏状态。
 */
export interface PlaybackState {
  readonly time: number;

  readonly score: number;
  readonly combo: number;
  readonly maxCombo: number;
  /** 0..1 */
  readonly accuracy: number;
  /** 0..1 */
  readonly hp: number;

  readonly counts: {
    readonly great: number;
    readonly ok: number;
    readonly meh: number;
    readonly miss: number;
  };

  readonly cursor: CursorSample;
  readonly activeObjects: readonly ActiveObject[];

  /** 最后一个已生效判定事件的下标;-1 表示尚无判定 */
  readonly lastEventIndex: number;
}
