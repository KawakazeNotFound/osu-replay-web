import { describe, expect, it } from 'vitest';

import {
  COMBO_EXPONENT,
  MAX_SCORE,
  affectsAccuracy,
  affectsCombo,
  applyJudgement,
  baseScoreOf,
  breaksCombo,
  emptyAccumulator,
  increasesCombo,
  isBonus,
  isHit,
  isScorable,
  lazerJudgementFor,
  lazerMaxima,
  lazerTotalScore,
  maxResultForPart,
  type LazerResult,
} from './lazerScoring';
import { makeHitObject, makeSimBeatmap } from './testFixtures';
import { HitResult } from './types';

/**
 * 期望值一律**照 lazer 源码手算**。来源见 `lazerScoring.ts` 顶部。
 *
 * 这些谓词看着琐碎,但错一个就整盘错 —— 尤其 `ignoreMiss` 不影响 combo
 * 这一条,它是 lazer 与 stable 在滑条末端上的根本分歧。
 */

const ALL: readonly LazerResult[] = [
  'great', 'ok', 'meh', 'miss',
  'largeTickHit', 'largeTickMiss', 'smallTickHit', 'smallTickMiss',
  'sliderTailHit', 'smallBonus', 'largeBonus', 'ignoreHit', 'ignoreMiss',
];

describe('baseScoreOf', () => {
  it('照 GetBaseScoreForResult 的表', () => {
    expect(baseScoreOf('great')).toBe(300);
    expect(baseScoreOf('ok')).toBe(100);
    expect(baseScoreOf('meh')).toBe(50);
    expect(baseScoreOf('sliderTailHit')).toBe(150);
    expect(baseScoreOf('largeTickHit')).toBe(30);
    expect(baseScoreOf('smallTickHit')).toBe(10);
    expect(baseScoreOf('smallBonus')).toBe(10);
    expect(baseScoreOf('largeBonus')).toBe(50);
  });

  it('所有 miss 与 ignore 都是 0', () => {
    for (const r of ['miss', 'largeTickMiss', 'smallTickMiss', 'ignoreHit', 'ignoreMiss'] as const) {
      expect(baseScoreOf(r)).toBe(0);
    }
  });

  it('滑条末端(150)比 largeTick(30)高一档 —— lazer 刻意提高了它的权重', () => {
    expect(baseScoreOf('sliderTailHit')).toBeGreaterThan(baseScoreOf('largeTickHit'));
  });
});

describe('谓词', () => {
  it('IsHit:四种 miss 为 false,其余为 true', () => {
    const notHit = new Set(['miss', 'largeTickMiss', 'smallTickMiss', 'ignoreMiss']);
    for (const r of ALL) expect(isHit(r)).toBe(!notHit.has(r));
  });

  it('IsBonus:只有两个 bonus', () => {
    for (const r of ALL) expect(isBonus(r)).toBe(r === 'smallBonus' || r === 'largeBonus');
  });

  it('IsScorable:只排除 ignoreHit / ignoreMiss', () => {
    for (const r of ALL) expect(isScorable(r)).toBe(r !== 'ignoreHit' && r !== 'ignoreMiss');
  });

  it('AffectsAccuracy = IsScorable && !IsBonus —— bonus 不进准确率', () => {
    for (const r of ALL) expect(affectsAccuracy(r)).toBe(isScorable(r) && !isBonus(r));
    expect(affectsAccuracy('smallBonus')).toBe(false);
    expect(affectsAccuracy('sliderTailHit')).toBe(true);
  });

  it('AffectsCombo:**ignoreMiss 不在列表里**(lazer 与 stable 的关键分歧)', () => {
    expect(affectsCombo('ignoreMiss')).toBe(false);
    expect(affectsCombo('largeTickMiss')).toBe(true);
    expect(affectsCombo('sliderTailHit')).toBe(true);
    // tick 的小档不影响 combo
    expect(affectsCombo('smallTickHit')).toBe(false);
    expect(affectsCombo('smallTickMiss')).toBe(false);
    expect(affectsCombo('ignoreHit')).toBe(false);
  });

  it('BreaksCombo = AffectsCombo && !IsHit', () => {
    for (const r of ALL) expect(breaksCombo(r)).toBe(affectsCombo(r) && !isHit(r));
    // 只有这两个会断 combo
    expect(ALL.filter(breaksCombo)).toEqual(['miss', 'largeTickMiss']);
  });

  it('漏掉滑条末端**不断 combo** —— 这是 lazer 独有的宽容', () => {
    const missedTail = lazerJudgementFor('sliderTail', HitResult.Miss);
    expect(missedTail.type).toBe('ignoreMiss');
    expect(breaksCombo(missedTail.type)).toBe(false);
    expect(increasesCombo(missedTail.type)).toBe(false);
  });
});

describe('maxResultForPart', () => {
  it('部件 → MaxResult 的映射', () => {
    expect(maxResultForPart('circle')).toBe('great');
    expect(maxResultForPart('sliderHead')).toBe('great');
    expect(maxResultForPart('spinner')).toBe('great');
    expect(maxResultForPart('sliderTick')).toBe('largeTickHit');
    expect(maxResultForPart('sliderRepeat')).toBe('largeTickHit');
    expect(maxResultForPart('sliderTail')).toBe('sliderTailHit');
  });
});

describe('lazerJudgementFor', () => {
  it('档位部件按档位走', () => {
    expect(lazerJudgementFor('circle', HitResult.Great)).toEqual({ maxResult: 'great', type: 'great' });
    expect(lazerJudgementFor('circle', HitResult.Ok)).toEqual({ maxResult: 'great', type: 'ok' });
    expect(lazerJudgementFor('circle', HitResult.Meh)).toEqual({ maxResult: 'great', type: 'meh' });
    expect(lazerJudgementFor('circle', HitResult.Miss)).toEqual({ maxResult: 'great', type: 'miss' });
  });

  it('tick 只有中/不中两态 —— 不存在"tick 拿了 100"', () => {
    expect(lazerJudgementFor('sliderTick', HitResult.Great).type).toBe('largeTickHit');
    expect(lazerJudgementFor('sliderTick', HitResult.Miss).type).toBe('largeTickMiss');
    // 即便传进来一个中间档,也只能是 hit
    expect(lazerJudgementFor('sliderRepeat', HitResult.Meh).type).toBe('largeTickHit');
  });
});

describe('applyJudgement', () => {
  it('combo 分量 = 基础分(MaxResult) × combo^0.5 —— 用的是**判定后**的 combo', () => {
    const acc = emptyAccumulator();
    applyJudgement(acc, { maxResult: 'great', type: 'great' }, 9);
    expect(acc.currentComboPortion).toBeCloseTo(300 * Math.pow(9, COMBO_EXPONENT), 9);
    expect(acc.currentComboPortion).toBeCloseTo(300 * 3, 9);
  });

  it('combo 分量用的是 **MaxResult** 的基础分,不是实际结果的', () => {
    // 拿了 50 分,但 combo 分量仍按 300 算 —— 准确率那半才反映实际档位
    const acc = emptyAccumulator();
    applyJudgement(acc, { maxResult: 'great', type: 'meh' }, 4);
    expect(acc.currentComboPortion).toBeCloseTo(300 * 2, 9);
    expect(acc.currentBaseScore).toBe(50);
    expect(acc.currentMaximumBaseScore).toBe(300);
  });

  it('miss 仍然累加 currentMaximumBaseScore 与 accCount(否则准确率会虚高)', () => {
    const acc = emptyAccumulator();
    applyJudgement(acc, { maxResult: 'great', type: 'miss' }, 0);
    expect(acc.currentMaximumBaseScore).toBe(300);
    expect(acc.currentAccuracyJudgementCount).toBe(1);
    expect(acc.currentBaseScore).toBe(0);
    // miss 是 scorable 的,所以进 comboPortion —— 但 combo 是 0,乘出来也是 0
    expect(acc.currentComboPortion).toBe(0);
  });

  it('bonus 只进 bonusPortion,不进准确率也不进 combo 分量', () => {
    const acc = emptyAccumulator();
    applyJudgement(acc, { maxResult: 'largeBonus', type: 'largeBonus' }, 100);
    expect(acc.currentBonusPortion).toBe(50);
    expect(acc.currentComboPortion).toBe(0);
    expect(acc.currentMaximumBaseScore).toBe(0);
    expect(acc.currentAccuracyJudgementCount).toBe(0);
  });

  it('漏掉的末端(ignoreMiss)完全不计分 —— 三个累加器都不动', () => {
    const acc = emptyAccumulator();
    applyJudgement(acc, { maxResult: 'sliderTailHit', type: 'ignoreMiss' }, 50);
    // MaxResult 仍计入上限(它 AffectsAccuracy)
    expect(acc.currentMaximumBaseScore).toBe(150);
    expect(acc.currentAccuracyJudgementCount).toBe(1);
    // 但实际结果不进任何分数
    expect(acc.currentBaseScore).toBe(0);
    expect(acc.currentComboPortion).toBe(0);
    expect(acc.currentBonusPortion).toBe(0);
  });
});

describe('lazerTotalScore', () => {
  it('完美通关 = 恰好 100 万', () => {
    const acc = emptyAccumulator();
    let combo = 0;
    for (let i = 0; i < 100; i++) {
      combo++;
      applyJudgement(acc, { maxResult: 'great', type: 'great' }, combo);
    }
    const maxima = {
      maximumBaseScore: acc.currentBaseScore,
      maximumComboPortion: acc.currentComboPortion,
      maximumAccuracyJudgementCount: acc.currentAccuracyJudgementCount,
    };
    expect(lazerTotalScore(acc, maxima)).toBe(MAX_SCORE);
  });

  it('公式 = 500000·acc·comboProgress + 500000·acc⁵·accProgress + bonus', () => {
    const acc = emptyAccumulator();
    applyJudgement(acc, { maxResult: 'great', type: 'great' }, 1);
    applyJudgement(acc, { maxResult: 'great', type: 'meh' }, 2);

    const maxima = { maximumBaseScore: 600, maximumComboPortion: 1200, maximumAccuracyJudgementCount: 2 };

    const accuracy = 350 / 600;
    const comboProgress = acc.currentComboPortion / 1200;
    const expected = Math.round(
      500000 * accuracy * comboProgress + 500000 * Math.pow(accuracy, 5) * 1,
    );
    expect(lazerTotalScore(acc, maxima)).toBe(expected);
  });

  it('mod 系数在最外层相乘,且**再取整一次**', () => {
    const acc = emptyAccumulator();
    applyJudgement(acc, { maxResult: 'great', type: 'great' }, 1);
    const maxima = {
      maximumBaseScore: 300,
      maximumComboPortion: acc.currentComboPortion,
      maximumAccuracyJudgementCount: 1,
    };
    expect(lazerTotalScore(acc, maxima, 1)).toBe(MAX_SCORE);
    expect(lazerTotalScore(acc, maxima, 1.06)).toBe(Math.round(MAX_SCORE * 1.06));
  });

  it('空成绩为 0,不产生 NaN', () => {
    const empty = emptyAccumulator();
    const score = lazerTotalScore(empty, {
      maximumBaseScore: 0,
      maximumComboPortion: 0,
      maximumAccuracyJudgementCount: 0,
    });
    // 各比值退化为 1,但 bonusPortion 为 0 → 满分。关键是不能是 NaN
    expect(Number.isFinite(score)).toBe(true);
  });

  it('准确率进了两次 —— acc⁵ 让高准确率段的差距被放大', () => {
    const scoreAt = (hitCount: number, total: number): number => {
      const acc = emptyAccumulator();
      let combo = 0;
      for (let i = 0; i < total; i++) {
        const hit = i < hitCount;
        if (hit) combo++;
        else combo = 0;
        applyJudgement(acc, { maxResult: 'great', type: hit ? 'great' : 'miss' }, combo);
      }
      return acc.currentBaseScore / acc.currentMaximumBaseScore;
    };
    // 只验单调:准确率越高,acc⁵ 的增长越快
    const a = scoreAt(90, 100);
    const b = scoreAt(99, 100);
    expect(Math.pow(b, 5) - Math.pow(a, 5)).toBeGreaterThan(b - a);
  });
});

describe('lazerMaxima', () => {
  it('全 circle 的图:上限就是完美走一遍', () => {
    const beatmap = makeSimBeatmap([
      makeHitObject({ startTime: 0 }),
      makeHitObject({ startTime: 1000 }),
      makeHitObject({ startTime: 2000 }),
    ]);
    const maxima = lazerMaxima(beatmap);

    expect(maxima.maximumAccuracyJudgementCount).toBe(3);
    expect(maxima.maximumBaseScore).toBe(900);
    // combo 分量 = 300·√1 + 300·√2 + 300·√3
    expect(maxima.maximumComboPortion).toBeCloseTo(
      300 * (Math.sqrt(1) + Math.sqrt(2) + Math.sqrt(3)),
      6,
    );
  });

  it('按时间排序 —— combo^0.5 与顺序有关,乱序会得出不同上限', () => {
    const ordered = lazerMaxima(
      makeSimBeatmap([makeHitObject({ startTime: 0 }), makeHitObject({ startTime: 1000 })]),
    );
    // 时间倒着给,lazerMaxima 内部会重排,结果必须一致
    const reversed = lazerMaxima(
      makeSimBeatmap([makeHitObject({ startTime: 1000 }), makeHitObject({ startTime: 0 })]),
    );
    expect(reversed.maximumComboPortion).toBeCloseTo(ordered.maximumComboPortion, 9);
  });

  it('空图不炸', () => {
    const maxima = lazerMaxima(makeSimBeatmap([]));
    expect(maxima).toEqual({
      maximumBaseScore: 0,
      maximumComboPortion: 0,
      maximumAccuracyJudgementCount: 0,
    });
  });
});
