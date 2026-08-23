import { describe, expect, it } from 'vitest';

import { buildReplayFrames } from '../replay/frames';
import { HIT_ANIMATION_MS, TIMELINE_PADDING_MS, preemptFromAR } from './difficulty';
import {
  buildDrainProfile,
  buildTimeline,
  buildVisualIndex,
  emptyTimeline,
  placeholderBeatmap,
  type JudgementPass,
} from './timeline';
import {
  HitResult,
  ZERO_CUMULATIVE,
  type BreakPeriod,
  type DrainProfile,
  type JudgementEvent,
  type SimBeatmap,
  type SimHitObject,
} from './types';

/* ---------------- 造数据 ---------------- */

function obj(
  startTime: number,
  endTime: number = startTime,
  kind: SimHitObject['kind'] = 'circle',
): SimHitObject {
  return {
    kind,
    startTime,
    endTime,
    x: 256,
    y: 192,
    newCombo: false,
    comboIndex: 0,
    indexInCombo: 1,
  };
}

function makeBeatmap(
  hitObjects: readonly SimHitObject[],
  breaks: readonly BreakPeriod[] = [],
  overrides: Partial<SimBeatmap> = {},
): SimBeatmap {
  return {
    hitObjects,
    breaks,
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
    ...overrides,
  };
}

/** 把 DrainProfile 摊成好读的形式,便于直接对照期望。 */
function segmentsOf(profile: DrainProfile): { start: number; end: number; cum: number }[] {
  return Array.from(profile.segStart, (start, i) => ({
    start,
    end: profile.segEnd[i]!,
    cum: profile.cumDrainedMs[i]!,
  }));
}

const NO_FRAMES = buildReplayFrames([]);

/* ---------------- buildDrainProfile:break 的裁剪与合并 ---------------- */

describe('buildDrainProfile', () => {
  it('无 break 时是覆盖物件范围的单一区间', () => {
    const profile = buildDrainProfile(makeBeatmap([obj(1000), obj(5000)]), 0.001);

    expect(segmentsOf(profile)).toEqual([{ start: 1000, end: 5000, cum: 0 }]);
  });

  it('中间一个 break 切成两段,并累出前缀和', () => {
    const profile = buildDrainProfile(
      makeBeatmap([obj(1000), obj(10000)], [{ start: 4000, end: 6000 }]),
      0.001,
    );

    expect(segmentsOf(profile)).toEqual([
      { start: 1000, end: 4000, cum: 0 },
      // 第二段之前已累积 3000ms 有效流失 —— break 的 2000ms 不计入
      { start: 6000, end: 10000, cum: 3000 },
    ]);
  });

  it('重叠的 break 会被合并', () => {
    const profile = buildDrainProfile(
      makeBeatmap(
        [obj(0), obj(10000)],
        [
          { start: 2000, end: 5000 },
          { start: 4000, end: 7000 }, // 与前一个重叠
        ],
      ),
      0.001,
    );

    expect(segmentsOf(profile)).toEqual([
      { start: 0, end: 2000, cum: 0 },
      { start: 7000, end: 10000, cum: 2000 },
    ]);
  });

  it('首尾相接的 break 也会被合并,不产生零长度区间', () => {
    const profile = buildDrainProfile(
      makeBeatmap(
        [obj(0), obj(10000)],
        [
          { start: 2000, end: 5000 },
          { start: 5000, end: 7000 }, // 恰好接上
        ],
      ),
      0.001,
    );

    // 若合并条件写成 `<` 而不是 `<=`,这里会多出一个 {5000,5000} 的空段
    expect(segmentsOf(profile)).toEqual([
      { start: 0, end: 2000, cum: 0 },
      { start: 7000, end: 10000, cum: 2000 },
    ]);
  });

  it('乱序给出的 break 不影响结果', () => {
    const ordered = buildDrainProfile(
      makeBeatmap(
        [obj(0), obj(20000)],
        [
          { start: 2000, end: 4000 },
          { start: 8000, end: 9000 },
        ],
      ),
      0.001,
    );
    const shuffled = buildDrainProfile(
      makeBeatmap(
        [obj(0), obj(20000)],
        [
          { start: 8000, end: 9000 },
          { start: 2000, end: 4000 },
        ],
      ),
      0.001,
    );

    expect(segmentsOf(shuffled)).toEqual(segmentsOf(ordered));
  });

  it('超出物件范围的 break 被裁剪到范围内', () => {
    const profile = buildDrainProfile(
      makeBeatmap(
        [obj(1000), obj(5000)],
        [
          { start: -9999, end: 2000 }, // 左端越界
          { start: 4000, end: 9999 }, // 右端越界
        ],
      ),
      0.001,
    );

    // 裁剪后为 [1000,2000] 与 [4000,5000],于是流失区间只剩中间那段
    expect(segmentsOf(profile)).toEqual([{ start: 2000, end: 4000, cum: 0 }]);
  });

  it('完全落在物件范围之外的 break 被丢弃', () => {
    const profile = buildDrainProfile(
      makeBeatmap([obj(1000), obj(5000)], [{ start: 6000, end: 8000 }]),
      0.001,
    );

    expect(segmentsOf(profile)).toEqual([{ start: 1000, end: 5000, cum: 0 }]);
  });

  it('break 覆盖整个物件范围时不产生任何流失区间', () => {
    const profile = buildDrainProfile(
      makeBeatmap([obj(1000), obj(5000)], [{ start: 0, end: 9999 }]),
      0.001,
    );

    expect(segmentsOf(profile)).toEqual([]);
  });

  it('零长度 break 被丢弃', () => {
    const profile = buildDrainProfile(
      makeBeatmap([obj(0), obj(5000)], [{ start: 2000, end: 2000 }]),
      0.001,
    );

    expect(segmentsOf(profile)).toEqual([{ start: 0, end: 5000, cum: 0 }]);
  });

  it('无物件时是空 profile', () => {
    const profile = buildDrainProfile(makeBeatmap([], [{ start: 0, end: 100 }]), 0.001);

    expect(segmentsOf(profile)).toEqual([]);
    expect(profile.drainPerMs).toBe(0.001);
  });

  it('滑条/转盘的 endTime 参与范围计算,不只看 startTime', () => {
    // 最后一个物件是 5000→12000 的转盘,流失范围必须延伸到 12000
    const profile = buildDrainProfile(makeBeatmap([obj(1000), obj(5000, 12000, 'spinner')]), 0.001);

    expect(segmentsOf(profile)).toEqual([{ start: 1000, end: 12000, cum: 0 }]);
  });
});

/* ---------------- buildVisualIndex ---------------- */

describe('buildVisualIndex', () => {
  const AR = 9;
  const PREEMPT = preemptFromAR(AR);

  it('visualStart 升序,且 order 能映射回原下标', () => {
    const beatmap = makeBeatmap([obj(1000), obj(1500), obj(2000, 8000, 'slider')]);
    const index = buildVisualIndex(beatmap);

    expect(Array.from(index.visualStart)).toEqual([
      1000 - PREEMPT,
      1500 - PREEMPT,
      2000 - PREEMPT,
    ]);
    expect(Array.from(index.order)).toEqual([0, 1, 2]);
  });

  it('visualEnd 取 endTime 加命中动画尾巴', () => {
    const index = buildVisualIndex(makeBeatmap([obj(1000, 4000, 'slider')]));

    expect(index.visualEnd[0]).toBe(4000 + HIT_ANIMATION_MS);
  });

  it('maxVisualDuration 等于最长物件的视觉窗口', () => {
    // 长物件 2000→9000:窗口 = preempt + 7000 + 命中动画
    const index = buildVisualIndex(
      makeBeatmap([obj(1000), obj(2000, 9000, 'spinner'), obj(3000)]),
    );

    expect(index.maxVisualDuration).toBe(PREEMPT + 7000 + HIT_ANIMATION_MS);
  });

  it('空谱面返回空索引且 maxVisualDuration 为 0', () => {
    const index = buildVisualIndex(makeBeatmap([]));

    expect(index.order.length).toBe(0);
    expect(index.maxVisualDuration).toBe(0);
  });

  it('AR 越低 visualStart 越早', () => {
    const low = buildVisualIndex(makeBeatmap([obj(5000)], [], { difficulty: { ...makeBeatmap([]).difficulty, approachRate: 3 } }));
    const high = buildVisualIndex(makeBeatmap([obj(5000)], [], { difficulty: { ...makeBeatmap([]).difficulty, approachRate: 10 } }));

    expect(low.visualStart[0]!).toBeLessThan(high.visualStart[0]!);
  });
});

/* ---------------- buildTimeline:时间轴范围 = 物件 ∪ 回放帧 ---------------- */

describe('buildTimeline 的时间轴范围', () => {
  const PREEMPT = preemptFromAR(9);

  it('只有物件时,范围由物件与 preempt 决定', () => {
    const timeline = buildTimeline(makeBeatmap([obj(1000), obj(5000)]), NO_FRAMES);

    expect(timeline.startTime).toBe(1000 - PREEMPT - TIMELINE_PADDING_MS);
    expect(timeline.endTime).toBe(5000 + TIMELINE_PADDING_MS);
  });

  it('回放帧超出最后一个物件时,endTime 跟着帧走', () => {
    // 玩家在最后一个物件之后仍会移动光标 —— 这是真实回放的常态
    const frames = buildReplayFrames([
      { startTime: 0, x: 0, y: 0, keys: 0 },
      { startTime: 30000, x: 1, y: 1, keys: 0 },
    ]);
    const timeline = buildTimeline(makeBeatmap([obj(1000), obj(5000)]), frames);

    expect(timeline.endTime).toBe(30000 + TIMELINE_PADDING_MS);
  });

  it('回放帧早于第一个物件的视觉起点时,startTime 跟着帧走', () => {
    // lazer 回放实测帧起点可到 -1781ms(见 TECH-NOTES B4)
    const frames = buildReplayFrames([
      { startTime: -1781, x: 0, y: 0, keys: 0 },
      { startTime: 5000, x: 1, y: 1, keys: 0 },
    ]);
    const timeline = buildTimeline(makeBeatmap([obj(1000), obj(5000)]), frames);

    expect(timeline.startTime).toBe(-1781 - TIMELINE_PADDING_MS);
  });

  it('物件视觉起点早于回放帧时,startTime 用物件的', () => {
    const frames = buildReplayFrames([{ startTime: 900, x: 0, y: 0, keys: 0 }]);
    const timeline = buildTimeline(makeBeatmap([obj(1000)]), frames);

    // 1000 - 600 = 400 比 900 更早
    expect(timeline.startTime).toBe(1000 - PREEMPT - TIMELINE_PADDING_MS);
  });

  it('audioLeadIn 会把 startTime 推得更早', () => {
    const withLeadIn = buildTimeline(
      makeBeatmap([obj(1000)], [], { audioLeadIn: 3000 }),
      NO_FRAMES,
    );

    // 1000 - 3000 = -2000,比 1000 - preempt = 400 更早
    expect(withLeadIn.startTime).toBe(1000 - 3000 - TIMELINE_PADDING_MS);
  });

  it('没有物件时范围完全由回放帧决定 —— M0 就是这个状态', () => {
    const frames = buildReplayFrames([
      { startTime: -500, x: 0, y: 0, keys: 0 },
      { startTime: 60000, x: 1, y: 1, keys: 0 },
    ]);
    const timeline = buildTimeline(makeBeatmap([]), frames);

    expect(timeline.startTime).toBe(-500 - TIMELINE_PADDING_MS);
    expect(timeline.endTime).toBe(60000 + TIMELINE_PADDING_MS);
  });

  it('既无物件也无帧时退化成围绕 0 的一段余量', () => {
    const timeline = buildTimeline(makeBeatmap([]), NO_FRAMES);

    expect(timeline.startTime).toBe(-TIMELINE_PADDING_MS);
    expect(timeline.endTime).toBe(TIMELINE_PADDING_MS);
    expect(timeline.startTime).toBeLessThan(timeline.endTime);
  });

  it('startTime 恒小于 endTime', () => {
    const cases: readonly SimBeatmap[] = [
      makeBeatmap([]),
      makeBeatmap([obj(0)]),
      makeBeatmap([obj(-5000)]),
      makeBeatmap([obj(1000, 200000, 'spinner')]),
    ];

    for (const beatmap of cases) {
      const timeline = buildTimeline(beatmap, NO_FRAMES);
      expect(timeline.startTime).toBeLessThan(timeline.endTime);
    }
  });
});

/* ---------------- buildTimeline:判定接线 ---------------- */

describe('buildTimeline 的判定接线', () => {
  function eventAt(time: number, objectIndex: number): JudgementEvent {
    return {
      time,
      objectIndex,
      part: 'circle',
      result: HitResult.Great,
      cum: ZERO_CUMULATIVE,
    };
  }

  it('省略 judge 时产出无判定的时间线 —— M0 的状态', () => {
    const timeline = buildTimeline(makeBeatmap([obj(1000), obj(2000)]), NO_FRAMES);

    expect(timeline.events).toEqual([]);
    expect(timeline.eventTimes.length).toBe(0);
    // objectResults 仍需与物件一一对应,否则渲染层索引会越界
    expect(timeline.objectResults.length).toBe(2);
    expect(timeline.objectResults.every((r) => r === null)).toBe(true);
  });

  it('eventTimes 是 events 的时间投影', () => {
    const judge: JudgementPass = () => ({
      events: [eventAt(1010, 0), eventAt(2010, 1)],
      objectResults: [null, null],
    });
    const timeline = buildTimeline(makeBeatmap([obj(1000), obj(2000)]), NO_FRAMES, { judge });

    expect(Array.from(timeline.eventTimes)).toEqual([1010, 2010]);
  });

  it('拒绝时间倒退的事件流 —— 二分查询依赖这个不变量', () => {
    const judge: JudgementPass = () => ({
      events: [eventAt(2000, 1), eventAt(1000, 0)],
      objectResults: [null, null],
    });

    expect(() => buildTimeline(makeBeatmap([obj(1000), obj(2000)]), NO_FRAMES, { judge })).toThrow(
      /未按时间升序/,
    );
  });

  it('接受时间戳相同的相邻事件 —— 升序要求是非严格的', () => {
    // 真实回放存在零间隔帧(TECH-NOTES B6),一次点击可整个发生在同一时刻,
    // 因此同一时刻产生多条判定是合法的
    const judge: JudgementPass = () => ({
      events: [eventAt(1500, 0), eventAt(1500, 1)],
      objectResults: [null, null],
    });

    expect(() =>
      buildTimeline(makeBeatmap([obj(1000), obj(2000)]), NO_FRAMES, { judge }),
    ).not.toThrow();
  });

  it('maxJudgeableObjects 等于物件数', () => {
    const timeline = buildTimeline(makeBeatmap([obj(0), obj(1), obj(2)]), NO_FRAMES);

    expect(timeline.maxJudgeableObjects).toBe(3);
  });

  it('drainPerMs 透传到 DrainProfile,默认为 0', () => {
    expect(buildTimeline(makeBeatmap([obj(0)]), NO_FRAMES).drain.drainPerMs).toBe(0);
    expect(
      buildTimeline(makeBeatmap([obj(0)]), NO_FRAMES, { drainPerMs: 0.002 }).drain.drainPerMs,
    ).toBe(0.002);
  });
});

/* ---------------- 占位物 ---------------- */

describe('placeholderBeatmap / emptyTimeline', () => {
  it('占位谱面是空谱面但难度值合法', () => {
    const beatmap = placeholderBeatmap();

    expect(beatmap.hitObjects).toEqual([]);
    expect(beatmap.difficulty.approachRate).toBeGreaterThan(0);
    expect(preemptFromAR(beatmap.difficulty.approachRate)).toBeGreaterThan(0);
  });

  it('空时间线可以直接被查询而不崩', () => {
    const timeline = emptyTimeline();

    expect(timeline.events).toEqual([]);
    expect(timeline.frames.count).toBe(0);
    expect(timeline.startTime).toBeLessThan(timeline.endTime);
  });
});
