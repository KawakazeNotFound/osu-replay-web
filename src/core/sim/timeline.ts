import { EMPTY_FRAMES, type ReplayFrames } from '../replay/frames';
import { HIT_ANIMATION_MS, TIMELINE_PADDING_MS, preemptFromAR } from './difficulty';
import {
  ZERO_CUMULATIVE,
  type DrainProfile,
  type JudgementEvent,
  type ObjectResult,
  type ReplayTimeline,
  type SimBeatmap,
  type VisualIndex,
} from './types';

/**
 * 判定模拟 —— M1 起实现的可插拔环节。
 *
 * 必须是**纯函数**:同样的输入必须产出完全一致的事件流,否则 timeline 不可复现,
 * scrub 的正确性无从保证。
 *
 * 事件必须按 `time` 升序返回,且每个事件的 `cum` 必须是该事件生效后的累积状态。
 */
export type JudgementPass = (
  beatmap: SimBeatmap,
  frames: ReplayFrames,
) => {
  events: JudgementEvent[];
  objectResults: (ObjectResult | null)[];
};

export interface BuildTimelineOptions {
  /**
   * 判定模拟器。省略则产出一条**无判定事件**的时间线 —— 这正是 M0 的状态:
   * 足以驱动时钟、光标与 scrub,用来验证架构,但分数/连击恒为 0。
   */
  judge?: JudgementPass;

  /**
   * HP 被动流失速率(每 ms,0..1 标度)。
   *
   * TODO(M3): lazer 的 `HealthProcessor` 是靠二分搜索求出"玩家刚好能活过全图"
   * 的流失率,依赖完整判定序列,不是一个能从 HP 值直接算出的常数。
   * 现在给个占位值,等 M3 做 HP 条时再实现真实推导。见 TECH-NOTES D1。
   */
  drainPerMs?: number;
}

/**
 * 把 (谱面, 回放) 编译成不可变时间线。加载时执行一次。
 *
 * 这是唯一允许跑模拟的地方。运行时的所有查询(见 `query.ts`)都是纯读。
 */
export function buildTimeline(
  beatmap: SimBeatmap,
  frames: ReplayFrames,
  options: BuildTimelineOptions = {},
): ReplayTimeline {
  const objects = beatmap.hitObjects;

  const judged = options.judge?.(beatmap, frames) ?? {
    events: [],
    objectResults: new Array<ObjectResult | null>(objects.length).fill(null),
  };

  assertAscending(judged.events);

  const eventTimes = new Float64Array(judged.events.length);
  for (let i = 0; i < judged.events.length; i++) {
    eventTimes[i] = judged.events[i]!.time;
  }

  const visual = buildVisualIndex(beatmap);
  const drain = buildDrainProfile(beatmap, options.drainPerMs ?? 0);

  // 时间轴范围 = 物件范围 ∪ 回放帧范围。取并集有两个必要性:
  //   1. 玩家在最后一个物件之后仍会移动光标,回放帧常常超出谱面末尾
  //   2. M0 阶段还没接 .osu 解析,物件列表为空 —— 此时范围完全由回放帧决定
  const starts: number[] = [];
  const ends: number[] = [];

  if (objects.length > 0) {
    const firstStart = objects[0]!.startTime;
    // 左边界要能同时容纳最早的 approach circle 与 lead-in
    starts.push(Math.min(visual.visualStart[0]!, firstStart - beatmap.audioLeadIn));
    ends.push(objects[objects.length - 1]!.endTime);
  }

  if (frames.count > 0) {
    starts.push(frames.time[0]!);
    ends.push(frames.time[frames.count - 1]!);
  }

  const startTime = (starts.length > 0 ? Math.min(...starts) : 0) - TIMELINE_PADDING_MS;
  const endTime = (ends.length > 0 ? Math.max(...ends) : 0) + TIMELINE_PADDING_MS;

  return {
    beatmap,
    frames,
    events: judged.events,
    eventTimes,
    objectResults: judged.objectResults,
    visual,
    drain,
    startTime,
    endTime,
    maxJudgeableObjects: objects.length,
  };
}

/**
 * 占位谱面。
 *
 * M0 还没接 .osu 解析,先用一个默认难度的空谱面,让时间线可以只靠回放帧
 * 建立起来 —— 这足以验证「时钟 → stateAt → 渲染」链路。M1 接入真实解析后移除。
 */
export function placeholderBeatmap(): SimBeatmap {
  return {
    hitObjects: [],
    breaks: [],
    difficulty: {
      circleSize: 4,
      approachRate: 9,
      overallDifficulty: 8,
      drainRate: 5,
      sliderMultiplier: 1.4,
      sliderTickRate: 1,
    },
    audioLeadIn: 0,
    stackLeniency: 0.7,
  };
}

/** 空时间线,用于"还没加载任何东西"的初始状态。 */
export function emptyTimeline(): ReplayTimeline {
  return buildTimeline(placeholderBeatmap(), EMPTY_FRAMES);
}

/**
 * 预计算每个物件的视觉窗口并按起点排序。
 *
 * 有了这份索引,`activeObjectsAt(t)` 就是 O(log n + k),且不依赖上一帧的渲染结果
 * —— 这是 scrub 能做到"任意跳转都正确"的前提。
 */
export function buildVisualIndex(beatmap: SimBeatmap): VisualIndex {
  const objects = beatmap.hitObjects;
  const n = objects.length;

  const preempt = preemptFromAR(beatmap.difficulty.approachRate);

  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = objects[i]!;
    starts[i] = o.startTime - preempt;
    ends[i] = o.endTime + HIT_ANIMATION_MS;
  }

  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // 注意:hitObjects 本身按 startTime 有序,而 preempt 是全局常量,
  // 所以 visualStart 已经有序。但 AR 若将来变成 per-object(如 lazer 的
  // 部分 mod),这里就必须真排序 —— 保留排序步骤以免埋雷。
  const sorted = Array.from(order).sort((a, b) => starts[a]! - starts[b]!);

  const visualStart = new Float64Array(n);
  const visualEnd = new Float64Array(n);
  let maxVisualDuration = 0;

  for (let i = 0; i < n; i++) {
    const src = sorted[i]!;
    order[i] = src;
    visualStart[i] = starts[src]!;
    visualEnd[i] = ends[src]!;
    const duration = ends[src]! - starts[src]!;
    if (duration > maxVisualDuration) maxVisualDuration = duration;
  }

  return { order, visualStart, visualEnd, maxVisualDuration };
}

/**
 * 把时间轴切成 HP 流失生效的区间。
 *
 * 流失生效范围 = [第一个物件, 最后一个物件],再挖掉所有 break 区间。
 * `cumDrainedMs` 是前缀和,使 `hpAt` 保持 O(log n)。
 */
export function buildDrainProfile(beatmap: SimBeatmap, drainPerMs: number): DrainProfile {
  const objects = beatmap.hitObjects;

  if (objects.length === 0) {
    return {
      segStart: new Float64Array(0),
      segEnd: new Float64Array(0),
      cumDrainedMs: new Float64Array(0),
      drainPerMs,
    };
  }

  const rangeStart = objects[0]!.startTime;
  const rangeEnd = objects[objects.length - 1]!.endTime;

  // 只取落在范围内的 break,并按起点排序后合并重叠
  const breaks = beatmap.breaks
    .map((b) => ({ start: Math.max(b.start, rangeStart), end: Math.min(b.end, rangeEnd) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const b of breaks) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
    } else {
      merged.push({ start: b.start, end: b.end });
    }
  }

  const segs: { start: number; end: number }[] = [];
  let cursor = rangeStart;
  for (const b of merged) {
    if (b.start > cursor) segs.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < rangeEnd) segs.push({ start: cursor, end: rangeEnd });

  const count = segs.length;
  const segStart = new Float64Array(count);
  const segEnd = new Float64Array(count);
  const cumDrainedMs = new Float64Array(count);

  let accumulated = 0;
  for (let i = 0; i < count; i++) {
    const s = segs[i]!;
    segStart[i] = s.start;
    segEnd[i] = s.end;
    cumDrainedMs[i] = accumulated;
    accumulated += s.end - s.start;
  }

  return { segStart, segEnd, cumDrainedMs, drainPerMs };
}

function assertAscending(events: readonly JudgementEvent[]): void {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.time < events[i - 1]!.time) {
      throw new Error(
        `JudgementPass 返回的事件未按时间升序:events[${i}].time=${events[i]!.time} < ` +
          `events[${i - 1}].time=${events[i - 1]!.time}。时间线的二分查询依赖此不变量。`,
      );
    }
  }
}

/** 供 M1 判定实现复用:事件的初始累积状态。 */
export const INITIAL_CUMULATIVE = ZERO_CUMULATIVE;
