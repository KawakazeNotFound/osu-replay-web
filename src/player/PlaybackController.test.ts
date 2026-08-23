import { describe, expect, it } from 'vitest';

import { ManualClock } from '../core/clock/Clock';
import { buildReplayFrames } from '../core/replay/frames';
import { buildTimeline, placeholderBeatmap } from '../core/sim/timeline';
import { PlaybackController } from './PlaybackController';

/**
 * 刻意做成**不等间隔**的帧序列 —— 真实 .osr 就是这样(stable 约 60~1000Hz)。
 * 若测试数据等间隔,`stepReplayFrame` 与 `stepDisplayFrame` 的区别就测不出来。
 */
const FRAME_TIMES = [0, 17, 34, 35, 36, 100, 500, 502, 1000, 3000, 3001, 5000];

const TIMELINE = buildTimeline(
  placeholderBeatmap(),
  buildReplayFrames(FRAME_TIMES.map((t, i) => ({ startTime: t, x: i * 10, y: i * 5, keys: 0 }))),
);

function makeController(initialTime = 0) {
  const clock = new ManualClock(initialTime);
  return { clock, controller: new PlaybackController(clock, TIMELINE) };
}

describe('seek 与 skip', () => {
  it('夹在时间轴范围内', () => {
    const { controller } = makeController();

    controller.seek(-1e9);
    expect(controller.currentTime).toBe(TIMELINE.startTime);

    controller.seek(1e9);
    expect(controller.currentTime).toBe(TIMELINE.endTime);
  });

  it('skip 是相对跳转', () => {
    const { controller } = makeController(1000);
    controller.skip(500);
    expect(controller.currentTime).toBe(1500);
    controller.skip(-1500);
    expect(controller.currentTime).toBe(0);
  });

  it('反复 seek 同一时刻恒等', () => {
    const { controller } = makeController();
    for (const t of [0, 2500, 100, 2500, 0, 2500]) {
      controller.seek(t);
      expect(controller.currentTime).toBe(t);
    }
  });
});

describe('stepDisplayFrame(等间隔 1/60 秒)', () => {
  const STEP = 1000 / 60;

  it('单步步长为 1/60 秒', () => {
    const { controller } = makeController(1000);
    controller.stepDisplayFrame(1);
    expect(controller.currentTime).toBeCloseTo(1000 + STEP, 10);
    controller.stepDisplayFrame(-1);
    expect(controller.currentTime).toBeCloseTo(1000, 10);
  });

  it('前进 N 次再后退 N 次回到原点 —— M0 验收标准 5', () => {
    for (const n of [1, 5, 20, 60, 137]) {
      const { controller } = makeController(2000);
      const origin = controller.currentTime;

      for (let i = 0; i < n; i++) controller.stepDisplayFrame(1);
      expect(controller.currentTime).not.toBe(origin);
      for (let i = 0; i < n; i++) controller.stepDisplayFrame(-1);

      // 浮点累积误差必须小到看不见(1/60 秒 = 16.67ms,允许 1e-9)
      expect(controller.currentTime).toBeCloseTo(origin, 9);
    }
  });

  it('步进会暂停播放 —— 否则步完立刻被时钟带走', () => {
    const { controller } = makeController(1000);
    controller.togglePlay();
    expect(controller.isPlaying).toBe(true);

    controller.stepDisplayFrame(1);
    expect(controller.isPlaying).toBe(false);
  });

  it('在边界处不会越界', () => {
    const { controller } = makeController(TIMELINE.startTime);
    controller.stepDisplayFrame(-1);
    expect(controller.currentTime).toBe(TIMELINE.startTime);

    controller.seek(TIMELINE.endTime);
    controller.stepDisplayFrame(1);
    expect(controller.currentTime).toBe(TIMELINE.endTime);
  });
});

describe('stepReplayFrame(不等间隔的回放输入帧)', () => {
  it('每一步都精确落在某个帧的时刻上', () => {
    const { controller } = makeController(TIMELINE.startTime);

    for (let i = 0; i < FRAME_TIMES.length + 3; i++) {
      controller.stepReplayFrame(1);
      expect(FRAME_TIMES).toContain(controller.currentTime);
    }
  });

  it('依次走过全部帧,不跳号不重复', () => {
    const { controller } = makeController(TIMELINE.startTime);
    const visited: number[] = [];

    for (let i = 0; i < FRAME_TIMES.length; i++) {
      controller.stepReplayFrame(1);
      visited.push(controller.currentTime);
    }

    // 从时间轴起点(早于第 0 帧)出发,第一步应落在第 0 帧
    expect(visited).toEqual(FRAME_TIMES);
  });

  it('跨过 1ms 间隔的密集帧也不会漏 —— 34/35/36 三帧', () => {
    const { controller } = makeController(34);
    controller.stepReplayFrame(1);
    expect(controller.currentTime).toBe(35);
    controller.stepReplayFrame(1);
    expect(controller.currentTime).toBe(36);
    controller.stepReplayFrame(-1);
    expect(controller.currentTime).toBe(35);
  });

  it('前进 N 次再后退 N 次回到原点', () => {
    // 从 t=100(第 5 帧)出发:前方有 6 帧、后方有 5 帧,所以 N 最大取 5。
    // N 再大会在末帧饱和,往返就不对称了 —— 见下一条。
    for (const n of [1, 2, 3, 5]) {
      const { controller } = makeController(100);
      const origin = controller.currentTime;

      for (let i = 0; i < n; i++) controller.stepReplayFrame(1);
      expect(controller.currentTime).not.toBe(origin);
      for (let i = 0; i < n; i++) controller.stepReplayFrame(-1);

      expect(controller.currentTime, `n=${n}`).toBe(origin);
    }
  });

  it('在末帧饱和后往返不再对称 —— 这是钳制的固有行为,不是 bug', () => {
    const { controller } = makeController(100);
    const last = FRAME_TIMES[FRAME_TIMES.length - 1]!;

    // 前方只有 6 帧,走 7 步会在末帧停住(第 7 步空转)
    for (let i = 0; i < 7; i++) controller.stepReplayFrame(1);
    expect(controller.currentTime).toBe(last);

    // 后退 7 步则一步不浪费,于是比原点多退了一帧
    for (let i = 0; i < 7; i++) controller.stepReplayFrame(-1);
    expect(controller.currentTime).toBeLessThan(100);
  });

  it('落在两帧之间时,前后步各取最近的那一帧', () => {
    const { controller } = makeController(300); // 位于 100 与 500 之间
    controller.stepReplayFrame(1);
    expect(controller.currentTime).toBe(500);

    controller.seek(300);
    controller.stepReplayFrame(-1);
    expect(controller.currentTime).toBe(100);
  });

  it('到达两端后停住,不越界也不回绕', () => {
    const last = FRAME_TIMES[FRAME_TIMES.length - 1]!;
    const { controller } = makeController(last);
    controller.stepReplayFrame(1);
    expect(controller.currentTime).toBe(last);

    controller.seek(FRAME_TIMES[0]!);
    controller.stepReplayFrame(-1);
    expect(controller.currentTime).toBe(FRAME_TIMES[0]);
  });

  it('空回放时不崩', () => {
    const empty = buildTimeline(placeholderBeatmap(), buildReplayFrames([]));
    const controller = new PlaybackController(new ManualClock(0), empty);

    expect(() => controller.stepReplayFrame(1)).not.toThrow();
    expect(() => controller.stepReplayFrame(-1)).not.toThrow();
    expect(controller.currentTime).toBe(0);
  });
});

describe('togglePlay', () => {
  it('在播放与暂停之间切换', () => {
    const { controller } = makeController(0);
    expect(controller.isPlaying).toBe(false);
    controller.togglePlay();
    expect(controller.isPlaying).toBe(true);
    controller.togglePlay();
    expect(controller.isPlaying).toBe(false);
  });

  it('播完之后再按播放,从头开始', () => {
    const { controller } = makeController(TIMELINE.endTime);
    controller.togglePlay();
    expect(controller.currentTime).toBe(TIMELINE.startTime);
    expect(controller.isPlaying).toBe(true);
  });
});

describe('mod 倍率(D7)', () => {
  it('默认 modRate 为 1,时钟速率等于用户倍速', () => {
    const { clock, controller } = makeController();
    controller.setRate(2);
    expect(controller.modRate).toBe(1);
    expect(controller.userRate).toBe(2);
    expect(clock.rate).toBe(2);
  });

  it('时钟速率 = modRate × userRate', () => {
    const { clock, controller } = makeController();

    controller.setModRate(1.5); // DT
    expect(clock.rate).toBe(1.5);

    controller.setRate(2);
    expect(clock.rate).toBe(3);

    controller.setRate(0.5);
    expect(clock.rate).toBe(0.75);
  });

  it('setModRate 不影响已设定的 userRate', () => {
    const { clock, controller } = makeController();
    controller.setRate(0.25);

    controller.setModRate(0.75); // HT
    expect(controller.userRate).toBe(0.25);
    expect(clock.rate).toBeCloseTo(0.1875, 10);
  });

  it('换回放时重设 modRate,不会漏到下一段', () => {
    const { clock, controller } = makeController();

    controller.setModRate(1.5); // 上一段是 DT
    expect(clock.rate).toBe(1.5);

    controller.setModRate(1); // 下一段是 NM
    expect(clock.rate).toBe(1);
  });

  it('两个倍率都必须 > 0', () => {
    const { controller } = makeController();
    expect(() => controller.setRate(0)).toThrow(RangeError);
    expect(() => controller.setRate(-1)).toThrow(RangeError);
    expect(() => controller.setModRate(0)).toThrow(RangeError);
    expect(() => controller.setModRate(-1)).toThrow(RangeError);
  });

  it('DT 下"1× 播放"意味着谱面时间以 1.5× 推进', () => {
    // 这条把 D7 的语义写进测试:回放帧时间戳是谱面时间,DT 表示它相对
    // 真实时间跑得更快。所以忠实还原时时钟速率必须是 1.5,而不是 1。
    const { clock, controller } = makeController();
    controller.setModRate(1.5);
    controller.setRate(1);

    expect(controller.userRate).toBe(1);
    expect(clock.rate).toBe(1.5);
  });
});

describe('clampedTime', () => {
  it('时钟跑出范围时仍返回范围内的值', () => {
    const { clock, controller } = makeController(0);

    // 时钟自由运行会越界 —— 直接操作 ManualClock 绕过 controller 的夹取
    clock.seek(TIMELINE.endTime + 99999);
    expect(controller.currentTime).toBeGreaterThan(TIMELINE.endTime);
    expect(controller.clampedTime).toBe(TIMELINE.endTime);

    clock.seek(TIMELINE.startTime - 99999);
    expect(controller.clampedTime).toBe(TIMELINE.startTime);
  });
});
