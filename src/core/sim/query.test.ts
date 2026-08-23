import { describe, expect, it } from 'vitest';

import { buildReplayFrames } from '../replay/frames';
import { HIT_ANIMATION_MS, preemptFromAR } from './difficulty';
import { activeObjectsAt, hpAt, stateAt } from './query';
import { buildTimeline, type JudgementPass } from './timeline';
import {
  HitResult,
  ZERO_CUMULATIVE,
  type CumulativeState,
  type JudgementEvent,
  type ObjectResult,
  type SimBeatmap,
  type SimHitObject,
} from './types';

/* ---------------- 造数据 ---------------- */

/**
 * 一张有意做得"不规整"的谱面:混着 circle / slider / spinner,
 * 物件时长差异很大 —— 这样 `activeObjectsAt` 的有界回溯才会被真正压到。
 * 若所有物件等长,回溯逻辑写错了也测不出来。
 */
function makeBeatmap(overrides: Partial<SimBeatmap> = {}): SimBeatmap {
  const specs: readonly (readonly [number, number, SimHitObject['kind']])[] = [
    [1000, 1000, 'circle'],
    [1300, 1300, 'circle'],
    [1600, 4200, 'slider'], // 很长,会横跨后面好几个物件
    [2000, 2000, 'circle'],
    [2400, 2400, 'circle'],
    [5000, 12000, 'spinner'], // 更长
    [6000, 6000, 'circle'],
    [13000, 13000, 'circle'],
    [13100, 13100, 'circle'],
  ];

  const hitObjects: SimHitObject[] = specs.map(([startTime, endTime, kind], i) => ({
    kind,
    startTime,
    endTime,
    x: 100 + i * 20,
    y: 150,
    // 本文件测的是 stateAt / activeObjectsAt / hpAt,与堆叠无关 —— 给中性值
    endX: 100 + i * 20,
    endY: 150,
    stackHeight: 0,
    stackedX: 100 + i * 20,
    stackedY: 150,
    spans: 1,
    newCombo: i === 0 || i === 5,
    comboIndex: i < 5 ? 0 : 1,
    indexInCombo: (i < 5 ? i : i - 5) + 1,
  }));

  return {
    hitObjects,
    breaks: [{ start: 7000, end: 12000 }],
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

const FRAMES = buildReplayFrames(
  Array.from({ length: 400 }, (_, i) => ({
    startTime: -500 + i * 40,
    x: (i * 7) % 512,
    y: (i * 13) % 384,
    keys: i % 5 === 0 ? 1 : 0,
  })),
);

/**
 * 一个玩具判定器:每个物件在 startTime + 10ms 产出一条判定,
 * 每第 4 个 miss。够用来让分数 / 连击 / HP 在时间轴上真的变化。
 */
const toyJudge: JudgementPass = (beatmap) => {
  const events: JudgementEvent[] = [];
  const objectResults: (ObjectResult | null)[] = [];
  let cum: CumulativeState = ZERO_CUMULATIVE;

  beatmap.hitObjects.forEach((object, objectIndex) => {
    const missed = objectIndex % 4 === 3;
    const time = object.startTime + 10;

    const combo = missed ? 0 : cum.combo + 1;
    cum = {
      score: cum.score + (missed ? 0 : 300 * Math.max(1, combo)),
      combo,
      maxCombo: Math.max(cum.maxCombo, combo),
      countGreat: cum.countGreat + (missed ? 0 : 1),
      countOk: cum.countOk,
      countMeh: cum.countMeh,
      countMiss: cum.countMiss + (missed ? 1 : 0),
      hp: Math.max(0, Math.min(1, cum.hp + (missed ? -0.15 : 0.05))),
    };

    events.push({
      time,
      objectIndex,
      part: 'circle',
      result: missed ? HitResult.Miss : HitResult.Great,
      cum,
    });
    objectResults.push({
      objectIndex,
      result: missed ? HitResult.Miss : HitResult.Great,
      hitTime: missed ? null : time,
    });
  });

  return { events, objectResults };
};

const TIMELINE = buildTimeline(makeBeatmap(), FRAMES, {
  judge: toyJudge,
  drainPerMs: 0.00005,
});

/** 覆盖全时间轴的采样点,故意包含物件边界、break 边界与判定时刻附近。 */
function probeTimes(): number[] {
  const times: number[] = [];
  for (let t = TIMELINE.startTime; t <= TIMELINE.endTime; t += 37) times.push(t);

  for (const object of TIMELINE.beatmap.hitObjects) {
    for (const offset of [-1, 0, 1, 9, 10, 11]) {
      times.push(object.startTime + offset, object.endTime + offset);
    }
  }
  for (const b of TIMELINE.beatmap.breaks) {
    for (const offset of [-1, 0, 1]) times.push(b.start + offset, b.end + offset);
  }
  return times;
}

/** stateAt 的可比较投影 —— activeObjects 摊平成下标串,便于逐位比对。 */
function fingerprint(t: number): string {
  const s = stateAt(TIMELINE, t);
  return [
    s.time,
    s.score,
    s.combo,
    s.maxCombo,
    s.accuracy,
    s.hp,
    s.counts.great,
    s.counts.ok,
    s.counts.meh,
    s.counts.miss,
    s.cursor.x,
    s.cursor.y,
    s.cursor.keys,
    s.cursor.frameIndex,
    s.lastEventIndex,
    s.activeObjects.map((a) => a.index).join('|'),
  ].join(',');
}

/* ---------------- 核心不变量 ---------------- */

describe('stateAt 的纯函数性', () => {
  it('同一个 t 反复查询恒等', () => {
    for (const t of probeTimes()) {
      const first = fingerprint(t);
      expect(fingerprint(t)).toBe(first);
      expect(fingerprint(t)).toBe(first);
    }
  });

  it('正序播放与随机 seek 结果完全一致', () => {
    const times = probeTimes();
    const sequential = new Map(times.map((t) => [t, fingerprint(t)]));

    // 用确定性 PRNG 打乱,失败时可复现
    let seed = 987654321;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const shuffled = [...times].sort(() => rnd() - 0.5);

    for (const t of shuffled) {
      expect(fingerprint(t)).toBe(sequential.get(t));
    }
  });

  it('倒序遍历与正序遍历结果一致', () => {
    const times = probeTimes();
    const forward = times.map(fingerprint);
    const backward = [...times].reverse().map(fingerprint).reverse();

    expect(backward).toEqual(forward);
  });
});

describe('stateAt 的单调性', () => {
  it('分数与 maxCombo 随 t 单调不减', () => {
    let lastScore = -1;
    let lastMaxCombo = -1;

    for (const t of probeTimes().sort((a, b) => a - b)) {
      const s = stateAt(TIMELINE, t);
      expect(s.score).toBeGreaterThanOrEqual(lastScore);
      expect(s.maxCombo).toBeGreaterThanOrEqual(lastMaxCombo);
      lastScore = s.score;
      lastMaxCombo = s.maxCombo;
    }
  });

  it('判定生效于事件时刻,而非物件 startTime', () => {
    const object = TIMELINE.beatmap.hitObjects[0]!;
    // toyJudge 把判定放在 startTime + 10
    expect(stateAt(TIMELINE, object.startTime + 9).score).toBe(0);
    expect(stateAt(TIMELINE, object.startTime + 10).score).toBeGreaterThan(0);
  });

  it('时间轴起点之前状态全零', () => {
    const s = stateAt(TIMELINE, TIMELINE.startTime);
    expect(s.score).toBe(0);
    expect(s.combo).toBe(0);
    expect(s.lastEventIndex).toBe(-1);
  });
});

/* ---------------- activeObjectsAt:对照暴力实现 ---------------- */

describe('activeObjectsAt 的有界回溯', () => {
  /** 暴力实现:扫全表。有界回溯的结果必须与它逐位一致。 */
  function bruteForce(t: number): number[] {
    const preempt = preemptFromAR(TIMELINE.beatmap.difficulty.approachRate);
    const out: number[] = [];

    TIMELINE.beatmap.hitObjects.forEach((o, i) => {
      if (o.startTime - preempt <= t && o.endTime + HIT_ANIMATION_MS >= t) out.push(i);
    });
    return out;
  }

  it('与暴力扫描结果一致', () => {
    for (const t of probeTimes()) {
      const fast = activeObjectsAt(TIMELINE, t).map((a) => a.index);
      expect(fast, `t=${t}`).toEqual(bruteForce(t));
    }
  });

  it('长物件横跨后续物件时不会被漏掉', () => {
    // 下标 5 是 5000→12000 的 spinner;t=11000 时它仍可见,
    // 而下标 6(6000 的 circle)已经消失。回溯若只看前一个物件就会漏掉 spinner。
    const visible = activeObjectsAt(TIMELINE, 11000).map((a) => a.index);
    expect(visible).toContain(5);
    expect(visible).not.toContain(6);
  });

  it('返回顺序为 visualStart 升序', () => {
    for (const t of probeTimes()) {
      const active = activeObjectsAt(TIMELINE, t);
      for (let i = 1; i < active.length; i++) {
        expect(active[i]!.object.startTime).toBeGreaterThanOrEqual(
          active[i - 1]!.object.startTime,
        );
      }
    }
  });

  it('带上了物件的判定结果', () => {
    const active = activeObjectsAt(TIMELINE, 1000);
    expect(active.length).toBeGreaterThan(0);
    expect(active[0]!.result?.objectIndex).toBe(active[0]!.index);
  });
});

/* ---------------- HP:break 区间不流失 ---------------- */

describe('hpAt 的分段流失', () => {
  const drain = TIMELINE.drain;

  it('break 区间内 HP 不流失', () => {
    const b = TIMELINE.beatmap.breaks[0]!;
    // 从 break 起点到终点,被动流失量应为 0
    const atStart = hpAt(drain, 1, b.start, b.start);
    const atEnd = hpAt(drain, 1, b.start, b.end);
    expect(atEnd).toBeCloseTo(atStart, 10);
  });

  it('break 之外正常流失', () => {
    const before = hpAt(drain, 1, 2000, 2000);
    const after = hpAt(drain, 1, 2000, 4000);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(1 - drain.drainPerMs * 2000, 10);
  });

  it('跨越 break 时只算 break 之外的时长', () => {
    const b = TIMELINE.beatmap.breaks[0]!;
    // 2000 → break 起点是有效流失;break 内部不算;break 结束到 12500 又算
    const expectedMs = b.start - 2000 + (12500 - b.end);
    expect(hpAt(drain, 1, 2000, 12500)).toBeCloseTo(1 - drain.drainPerMs * expectedMs, 10);
  });

  it('查询顺序不影响结果', () => {
    const times = probeTimes();
    const forward = times.map((t) => hpAt(drain, 1, 2000, t));
    const backward = [...times].reverse().map((t) => hpAt(drain, 1, 2000, t)).reverse();
    expect(backward).toEqual(forward);
  });

  it('钳制在 0..1', () => {
    // 注意:这条 drain 的有效流失总时长只有 7100ms(1000→7000 加 12000→13100),
    // 乘 drainPerMs=5e-5 只掉 0.355 —— 想测下界得换个够大的速率。
    expect(hpAt(drain, 1, 0, 1e9)).toBeCloseTo(1 - drain.drainPerMs * 7100, 10);
    expect(hpAt({ ...drain, drainPerMs: 1 }, 1, 0, 1e9)).toBe(0);

    // 查询时刻早于事件时刻 → 不应该"倒着补"HP
    expect(hpAt(drain, 1, 5000, 0)).toBe(1);
  });

  it('drainPerMs 为 0 时恒等于事件时刻的 HP', () => {
    const noDrain = { ...drain, drainPerMs: 0 };
    for (const t of probeTimes()) {
      expect(hpAt(noDrain, 0.42, 2000, t)).toBe(0.42);
    }
  });
});

/* ---------------- 边界:空时间线 ---------------- */

describe('空时间线', () => {
  const empty = buildTimeline(
    { ...makeBeatmap(), hitObjects: [], breaks: [] },
    buildReplayFrames([]),
  );

  it('stateAt 不崩,返回零状态与判定区中心光标', () => {
    const s = stateAt(empty, 1234);
    expect(s.score).toBe(0);
    expect(s.activeObjects).toEqual([]);
    expect(s.cursor.x).toBe(256);
    expect(s.cursor.y).toBe(192);
    expect(s.lastEventIndex).toBe(-1);
  });

  it('准确率在无判定时为 1 而非 NaN', () => {
    expect(stateAt(empty, 0).accuracy).toBe(1);
  });
});
