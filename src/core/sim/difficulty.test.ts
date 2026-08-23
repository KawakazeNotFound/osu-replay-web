import { describe, expect, it } from 'vitest';

import {
  GAMEFIELD_ROUNDING_ALLOWANCE,
  MISS_WINDOW,
  OBJECT_RADIUS,
  PREEMPT_MAX,
  PREEMPT_MID,
  PREEMPT_MIN,
  difficultyRange,
  fadeInFromPreempt,
  hitWindowsFromOD,
  preemptFromAR,
  radiusFromCS,
} from './difficulty';

/**
 * 期望值一律**按 lazer 源码的公式手算**,不从本文件的实现反推 —— 否则测试只是
 * 把当前行为固化下来,对错都测不出。已对照的源文件见 difficulty.ts 顶部注释。
 */

describe('difficultyRange', () => {
  it('0 / 5 / 10 三个锚点', () => {
    expect(difficultyRange(0, 80, 50, 20)).toBe(80);
    expect(difficultyRange(5, 80, 50, 20)).toBe(50);
    expect(difficultyRange(10, 80, 50, 20)).toBe(20);
  });

  it('与 lazer 的写法数学等价(含 v < 5 的分支)', () => {
    // lazer: v > 5 → mid + (max-mid)*(v-5)/5;v < 5 → mid + (mid-min)*(v-5)/5
    const lazer = (v: number, min: number, mid: number, max: number): number => {
      if (v > 5) return mid + ((max - mid) * (v - 5)) / 5;
      if (v < 5) return mid + ((mid - min) * (v - 5)) / 5;
      return mid;
    };

    for (const v of [0, 0.7, 1, 2.5, 3.3, 4.9, 5, 5.1, 6, 7.28, 8, 9.8, 10, 11]) {
      expect(difficultyRange(v, 80, 50, 20), `od=${v}`).toBeCloseTo(lazer(v, 80, 50, 20), 12);
      expect(difficultyRange(v, 1800, 1200, 450), `ar=${v}`).toBeCloseTo(
        lazer(v, 1800, 1200, 450), 12,
      );
    }
  });

  it('超出 0..10 时按两段直线继续外推(mod 会造成这种输入)', () => {
    // HR 把 AR 乘 1.4 后可能超过 10;lazer 刻意保留线性外推而不钳制
    expect(difficultyRange(11, 1800, 1200, 450)).toBeCloseTo(1200 - 150 * 6, 10);
  });
});

describe('preemptFromAR', () => {
  it('三个锚点', () => {
    expect(preemptFromAR(0)).toBe(PREEMPT_MAX);
    expect(preemptFromAR(5)).toBe(PREEMPT_MID);
    expect(preemptFromAR(10)).toBe(PREEMPT_MIN);
  });

  it('常见 AR 的 preempt', () => {
    // AR > 5 段斜率:(450-1200)/5 = -150 每点
    expect(preemptFromAR(9)).toBe(1200 - 150 * 4); // 600
    expect(preemptFromAR(8)).toBe(1200 - 150 * 3); // 750
    expect(preemptFromAR(9.5)).toBe(1200 - 150 * 4.5); // 525
    // AR < 5 段斜率:(1200-1800)/5 = -120 每点(往下走则 +120)
    expect(preemptFromAR(3)).toBe(1200 + 120 * 2); // 1440
  });

  it('向零取整 —— lazer 用的是 DifficultyRangeInt', () => {
    // AR 5.2 经 HR(×1.4)得 7.28:1200 - 150*2.28 = 858 恰好是整数
    expect(preemptFromAR(7.28)).toBe(858);

    // 造一个原始值带小数的:1200 - 150*(ar-5) 要非整数,需要 ar 的小数位更细
    const raw = difficultyRange(9.15, PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN);
    expect(raw).toBeCloseTo(577.5, 10);
    expect(preemptFromAR(9.15)).toBe(577); // 截断,不是四舍五入的 578
  });

  it('永远返回整数', () => {
    for (let ar = 0; ar <= 11; ar += 0.13) {
      expect(Number.isInteger(preemptFromAR(ar)), `ar=${ar}`).toBe(true);
    }
  });
});

describe('fadeInFromPreempt', () => {
  it('preempt >= 450 时恒为 400', () => {
    expect(fadeInFromPreempt(450)).toBe(400);
    expect(fadeInFromPreempt(600)).toBe(400);
    expect(fadeInFromPreempt(1800)).toBe(400);
  });

  it('preempt < 450 时按比例缩短 —— DT 压缩 preempt 时圈仍要淡入完毕', () => {
    expect(fadeInFromPreempt(225)).toBe(200);
    expect(fadeInFromPreempt(450 / 1.5)).toBeCloseTo(400 / 1.5, 10); // DT 下的 AR10
  });
});

describe('hitWindowsFromOD', () => {
  it('miss 窗口是常数 400,不随 OD 变化', () => {
    for (const od of [0, 5, 8, 10]) {
      expect(hitWindowsFromOD(od).miss).toBe(MISS_WINDOW);
    }
  });

  it('三档窗口 = floor(原始值) - 0.5', () => {
    // OD 8:great 原始 50 + (20-50)*0.6 = 32 → floor 32 - 0.5 = 31.5
    const w8 = hitWindowsFromOD(8);
    expect(w8.great).toBe(31.5);
    expect(w8.ok).toBe(100 + (60 - 100) * 0.6 - 0.5); // 76 - 0.5 = 75.5
    expect(w8.meh).toBe(119.5); // 150 + (100-150)*0.6 = 120 → 119.5

    // OD 5 的锚点
    const w5 = hitWindowsFromOD(5);
    expect(w5.great).toBe(49.5);
    expect(w5.ok).toBe(99.5);
    expect(w5.meh).toBe(149.5);
  });

  it('原始值带小数时先 floor 再减 0.5,不是四舍五入', () => {
    // OD 8.3:great = 50 - 30*0.66 = 30.2 → floor 30 - 0.5 = 29.5
    expect(difficultyRange(8.3, 80, 50, 20)).toBeCloseTo(30.2, 10);
    expect(hitWindowsFromOD(8.3).great).toBe(29.5);
  });

  it('窗口按 great < ok < meh < miss 排列', () => {
    for (const od of [0, 2.5, 5, 7, 8.3, 10]) {
      const w = hitWindowsFromOD(od);
      expect(w.great, `od=${od}`).toBeLessThan(w.ok);
      expect(w.ok, `od=${od}`).toBeLessThan(w.meh);
      expect(w.meh, `od=${od}`).toBeLessThan(w.miss);
    }
  });

  it('OD 越高窗口越窄', () => {
    let previous = Infinity;
    for (let od = 0; od <= 10; od += 0.5) {
      const great = hitWindowsFromOD(od).great;
      expect(great, `od=${od}`).toBeLessThanOrEqual(previous);
      previous = great;
    }
  });

  it('边界语义:偏差正好等于原始值时不算命中', () => {
    // OD 8 原始 great 窗口是 32。用 |delta| <= window 判定:
    const { great } = hitWindowsFromOD(8);
    expect(31 <= great).toBe(true);
    expect(32 <= great).toBe(false); // ← 这一条是 floor-0.5 存在的全部意义
  });
});

describe('radiusFromCS', () => {
  it('等于 lazer 的 OBJECT_RADIUS * scale,且带上 1.00041 的 fudge', () => {
    for (const cs of [0, 2, 3.5, 4, 5, 5.3, 6, 7, 9, 10]) {
      const scale = ((1 - (0.7 * (cs - 5)) / 5) / 2) * GAMEFIELD_ROUNDING_ALLOWANCE;
      expect(radiusFromCS(cs), `cs=${cs}`).toBeCloseTo(OBJECT_RADIUS * scale, 10);
    }
  });

  it('CS 5 时半径约 32(乘 fudge 后略大)', () => {
    expect(radiusFromCS(5)).toBeCloseTo(32 * GAMEFIELD_ROUNDING_ALLOWANCE, 10);
    expect(radiusFromCS(5)).toBeGreaterThan(32);
    expect(radiusFromCS(5)).toBeLessThan(32.02);
  });

  it('展开式 (54.4 - 4.48*cs) * 1.00041 应等价', () => {
    for (const cs of [0, 4, 5, 7, 10]) {
      expect(radiusFromCS(cs), `cs=${cs}`).toBeCloseTo(
        (54.4 - 4.48 * cs) * GAMEFIELD_ROUNDING_ALLOWANCE, 8,
      );
    }
  });

  it('CS 越大圈越小', () => {
    let previous = Infinity;
    for (let cs = 0; cs <= 10; cs += 0.5) {
      const r = radiusFromCS(cs);
      expect(r, `cs=${cs}`).toBeLessThan(previous);
      previous = r;
    }
  });
});
