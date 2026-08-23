import { describe, expect, it } from 'vitest';

import { makeHitObject, makeSimBeatmap } from './testFixtures';
import {
  SLIDER_END_SCORE,
  SLIDER_TICK_SCORE,
  difficultyPeppyStars,
  drainLengthSeconds,
  legacyModMultiplier,
  scoreIncrementFor,
  stableScoringFor,
} from './stableScoring';

/**
 * 期望值一律**按 lazer 源码的公式手算**。来源见 `stableScoring.ts` 顶部。
 */

describe('drainLengthSeconds', () => {
  it('= (末物件 startTime - 首物件 startTime - break 总长) / 1000,向零取整', () => {
    const beatmap = makeSimBeatmap([
      makeHitObject({ startTime: 1000 }),
      makeHitObject({ startTime: 61000 }),
    ]);
    expect(drainLengthSeconds(beatmap)).toBe(60);
  });

  it('扣掉 break', () => {
    const beatmap = makeSimBeatmap(
      [makeHitObject({ startTime: 0 }), makeHitObject({ startTime: 100000 })],
      { breaks: [{ start: 20000, end: 30000 }] },
    );
    // (100000 - 0 - 10000) / 1000 = 90
    expect(drainLengthSeconds(beatmap)).toBe(90);
  });

  it('用末物件的 **startTime**,不是 endTime', () => {
    // 这条锁住 lazer 的一个反直觉细节
    const beatmap = makeSimBeatmap([
      makeHitObject({ startTime: 0 }),
      makeHitObject({ kind: 'spinner', startTime: 10000, endTime: 60000 }),
    ]);
    expect(drainLengthSeconds(beatmap)).toBe(10);
  });

  it('每个时间戳先各自四舍五入再相减', () => {
    const beatmap = makeSimBeatmap([
      makeHitObject({ startTime: 0.4 }),
      makeHitObject({ startTime: 10000.6 }),
    ]);
    // round(10001) - round(0) = 10001 → /1000 → 10
    expect(drainLengthSeconds(beatmap)).toBe(10);
  });

  it('空谱面为 0,不除零', () => {
    expect(drainLengthSeconds(makeSimBeatmap([]))).toBe(0);
  });
});

describe('difficultyPeppyStars', () => {
  const beatmap = makeSimBeatmap([], {
    difficulty: {
      circleSize: 4,
      approachRate: 9,
      overallDifficulty: 8,
      drainRate: 5,
      sliderMultiplier: 1.4,
      sliderTickRate: 1,
    },
  });

  it('= round((HP + OD + CS + 物件/drain*8 的钳制值) / 38 * 5)', () => {
    // HP 5 + OD 8 + CS 4 = 17;766/209*8 = 29.3 → 钳到 16;(17+16)/38*5 = 4.34 → 4
    expect(difficultyPeppyStars(beatmap, 766, 209)).toBe(4);
  });

  it('物件密度比值钳制在 0..16', () => {
    // 极稀疏:比值接近 0 → (17+0)/38*5 = 2.24 → 2
    expect(difficultyPeppyStars(beatmap, 1, 100000)).toBe(2);
    // 极密集:比值钳到 16
    expect(difficultyPeppyStars(beatmap, 100000, 1)).toBe(difficultyPeppyStars(beatmap, 766, 1));
  });

  it('drainLength 为 0 时比值取 16', () => {
    // (17 + 16) / 38 * 5 = 4.34 → 4
    expect(difficultyPeppyStars(beatmap, 500, 0)).toBe(4);
  });

  it('难度越高系数越大', () => {
    const hard = makeSimBeatmap([], {
      difficulty: { ...beatmap.difficulty, drainRate: 10, overallDifficulty: 10, circleSize: 10 },
    });
    expect(difficultyPeppyStars(hard, 766, 209)).toBeGreaterThan(
      difficultyPeppyStars(beatmap, 766, 209),
    );
  });
});

describe('legacyModMultiplier', () => {
  it('无 mod 为 1', () => {
    expect(legacyModMultiplier(0)).toBe(1);
  });

  it('各 mod 的系数', () => {
    expect(legacyModMultiplier(1)).toBeCloseTo(0.5, 10); // NF
    expect(legacyModMultiplier(2)).toBeCloseTo(0.5, 10); // EZ
    expect(legacyModMultiplier(8)).toBeCloseTo(1.06, 10); // HD
    expect(legacyModMultiplier(16)).toBeCloseTo(1.06, 10); // HR
    expect(legacyModMultiplier(64)).toBeCloseTo(1.12, 10); // DT
    expect(legacyModMultiplier(256)).toBeCloseTo(0.3, 10); // HT
    expect(legacyModMultiplier(1024)).toBeCloseTo(1.12, 10); // FL
    expect(legacyModMultiplier(4096)).toBeCloseTo(0.9, 10); // SO
  });

  it('多个 mod 相乘 —— HDFL', () => {
    // 8 | 1024 = 1032
    expect(legacyModMultiplier(1032)).toBeCloseTo(1.06 * 1.12, 10);
  });

  it('NC 与 DT 同系数(NC 会连带置位 DT)', () => {
    expect(legacyModMultiplier(64 | 512)).toBeCloseTo(1.12, 10);
  });

  it('Relax / Autopilot 直接归零,丢弃已累乘的部分', () => {
    expect(legacyModMultiplier(128)).toBe(0); // RX
    expect(legacyModMultiplier(8192)).toBe(0); // AP
    // 即使带了加分 mod 也是 0
    expect(legacyModMultiplier(8 | 128)).toBe(0);
  });
});

describe('scoreIncrementFor', () => {
  const options = { difficultyMultiplier: 4, modMultiplier: 1 };

  it('不吃 combo 加成的部件只得基础分', () => {
    expect(scoreIncrementFor(SLIDER_TICK_SCORE, 100, false, options)).toBe(SLIDER_TICK_SCORE);
    expect(scoreIncrementFor(SLIDER_END_SCORE, 100, false, options)).toBe(SLIDER_END_SCORE);
  });

  it('第一个物件没有 combo 加成(combo - 1 钳到 0)', () => {
    expect(scoreIncrementFor(300, 0, true, options)).toBe(300);
    expect(scoreIncrementFor(300, 1, true, options)).toBe(300);
  });

  it('= 基础分 + trunc((combo-1) * trunc(基础分/25) * 难度系数 * mod系数)', () => {
    // combo 前值 11 → (11-1) * trunc(300/25)=12 * 4 = 480
    expect(scoreIncrementFor(300, 11, true, options)).toBe(300 + 480);
  });

  it('**基础分 / 25 是整数除法** —— 这是刻意匹配 stable 的', () => {
    // 100/25 = 4 恰好整除;50/25 = 2 也整除。用 60 来卡:trunc(60/25) = 2,不是 2.4
    expect(scoreIncrementFor(60, 11, true, options)).toBe(60 + Math.trunc(10 * 2 * 4));
    // 若写成浮点除法会得 60 + 10*2.4*4 = 156,与上面不同
    expect(scoreIncrementFor(60, 11, true, options)).not.toBe(60 + 10 * 2.4 * 4);
  });

  it('mod 系数参与 combo 加成', () => {
    const withMod = { difficultyMultiplier: 4, modMultiplier: 1.06 };
    expect(scoreIncrementFor(300, 11, true, withMod)).toBe(300 + Math.trunc(10 * 12 * 4 * 1.06));
  });

  it('基础分为 0(miss)不加分', () => {
    expect(scoreIncrementFor(0, 500, true, options)).toBe(0);
  });

  it('每次各自 trunc —— 不是最后统一取整', () => {
    // 两次 1.5 的小数部分若累积会多出 1 分;各自 trunc 则不会
    const odd = { difficultyMultiplier: 1, modMultiplier: 1.05 };
    const once = scoreIncrementFor(100, 4, true, odd);
    // (4-1) * trunc(100/25)=4 * 1 * 1.05 = 12.6 → trunc → 12
    expect(once).toBe(100 + 12);
  });
});

describe('stableScoringFor', () => {
  it('把谱面与 mod 组装成记分参数', () => {
    const beatmap = makeSimBeatmap(
      [makeHitObject({ startTime: 0 }), makeHitObject({ startTime: 60000 })],
      {
        difficulty: {
          circleSize: 4,
          approachRate: 9,
          overallDifficulty: 8,
          drainRate: 5,
          sliderMultiplier: 1.4,
          sliderTickRate: 1,
        },
      },
    );

    const scoring = stableScoringFor(beatmap, 1032); // HDFL

    expect(scoring.modMultiplier).toBeCloseTo(1.06 * 1.12, 10);
    expect(scoring.difficultyMultiplier).toBe(
      difficultyPeppyStars(beatmap, 2, drainLengthSeconds(beatmap)),
    );
  });
});
