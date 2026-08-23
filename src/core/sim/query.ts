import { cursorAt } from '../replay/frames';
import { clamp, lastIndexAtOrBefore } from '../util/search';
import {
  ZERO_CUMULATIVE,
  type ActiveObject,
  type CumulativeState,
  type DrainProfile,
  type PlaybackState,
  type ReplayTimeline,
} from './types';

/**
 * 求 t 时刻的完整播放状态。**纯函数,无副作用。**
 *
 * 这是整个项目的核心查询。快进 / 快退 / 逐帧 / 倍速 全部等价于对不同的 t
 * 调用本函数 —— 不存在"倒退"这个特例,因为这里从不依赖上一帧的结果。
 *
 * 复杂度 O(log n + k),n = 判定事件数,k = t 时刻可见物件数。
 */
export function stateAt(timeline: ReplayTimeline, t: number): PlaybackState {
  const eventIndex = lastIndexAtOrBefore(timeline.eventTimes, timeline.events.length, t);
  const cum: CumulativeState =
    eventIndex >= 0 ? timeline.events[eventIndex]!.cum : ZERO_CUMULATIVE;

  const lastEventTime = eventIndex >= 0 ? timeline.eventTimes[eventIndex]! : timeline.startTime;

  return {
    time: t,
    score: cum.score,
    combo: cum.combo,
    maxCombo: cum.maxCombo,
    accuracy: accuracyOf(cum),
    hp: hpAt(timeline.drain, cum.hp, lastEventTime, t),
    counts: {
      great: cum.countGreat,
      ok: cum.countOk,
      meh: cum.countMeh,
      miss: cum.countMiss,
    },
    cursor: cursorAt(timeline.frames, t),
    activeObjects: activeObjectsAt(timeline, t),
    lastEventIndex: eventIndex,
  };
}

/**
 * osu!std 的准确率。
 *
 * TODO(M5): lazer 的 "standardised" 计分与 stable 不同,且滑条刻度会参与
 * 准确率计算。这里先用 stable 的经典公式。见 TECH-NOTES A2。
 */
export function accuracyOf(cum: CumulativeState): number {
  const hits = cum.countGreat + cum.countOk + cum.countMeh + cum.countMiss;
  if (hits === 0) return 1;

  const earned = 300 * cum.countGreat + 100 * cum.countOk + 50 * cum.countMeh;
  return earned / (300 * hits);
}

/**
 * 求 t 时刻的 HP。
 *
 * `hpAtLastEvent` 是最后一个判定事件生效后的 HP,从那时到 t 之间叠加被动流失。
 * 关键在于流失量按**有效流失时长**计算 —— break 区间和物件之外的时间不计。
 * 见 TECH-NOTES D1。
 */
export function hpAt(
  drain: DrainProfile,
  hpAtLastEvent: number,
  lastEventTime: number,
  t: number,
): number {
  if (drain.drainPerMs <= 0) return clamp(hpAtLastEvent, 0, 1);

  const elapsed = drainedMsBefore(drain, t) - drainedMsBefore(drain, lastEventTime);
  return clamp(hpAtLastEvent - drain.drainPerMs * Math.max(0, elapsed), 0, 1);
}

/** 从时间轴起点到 t 之间,HP 流失实际生效的累计毫秒数。O(log n)。 */
function drainedMsBefore(drain: DrainProfile, t: number): number {
  const n = drain.segStart.length;
  if (n === 0) return 0;

  const i = lastIndexAtOrBefore(drain.segStart, n, t);
  if (i < 0) return 0;

  // t 可能落在区间内、或已越过该区间(此时整段都计入)
  const within = Math.min(t, drain.segEnd[i]!) - drain.segStart[i]!;
  return drain.cumDrainedMs[i]! + Math.max(0, within);
}

/**
 * 求 t 时刻所有处于视觉窗口内的物件。
 *
 * 二分定位 + 有界回溯:回溯范围由 `maxVisualDuration` 界定,因为
 * `visualStart[i] < t - maxVisualDuration` 蕴含 `visualEnd[i] < t`,
 * 该物件及其之前的所有物件都不可能可见。
 *
 * 返回顺序为 `visualStart` 升序。渲染层需要注意 osu! 的图层约定是
 * **越早的物件画在越上层**,所以绘制时应倒序遍历。
 */
export function activeObjectsAt(timeline: ReplayTimeline, t: number): ActiveObject[] {
  const { visual, beatmap, objectResults } = timeline;
  const n = visual.order.length;
  if (n === 0) return [];

  const hi = lastIndexAtOrBefore(visual.visualStart, n, t);
  if (hi < 0) return [];

  const lowerBound = t - visual.maxVisualDuration;
  const out: ActiveObject[] = [];

  for (let i = hi; i >= 0; i--) {
    if (visual.visualStart[i]! < lowerBound) break;
    if (visual.visualEnd[i]! < t) continue;

    const index = visual.order[i]!;
    out.push({
      index,
      object: beatmap.hitObjects[index]!,
      result: objectResults[index] ?? null,
    });
  }

  out.reverse();
  return out;
}
