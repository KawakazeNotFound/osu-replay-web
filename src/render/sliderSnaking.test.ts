import { describe, expect, it } from 'vitest';

import { makeHitObject } from '../core/sim/testFixtures';
import { DEFAULT_SNAKING, snakeRangeAt } from './sliderSnaking';

/**
 * # 滑条 snaking 的规则
 *
 * 逐条对照 `SnakingSliderBody.UpdateProgress`(源码见 `sliderSnaking.ts` 头部)。
 *
 * 这里能断言**确切数值**,所以比通过渲染器间接测有价值得多 ——
 * 渲染器那侧只需要验"确实用了这个区间"。
 */

const PREEMPT = 600; // AR9:difficultyRange(9, 1800, 1200, 450) = 600
const SNAKE_IN_WINDOW = PREEMPT / 3; // 200ms
const START = 1000;
const DURATION = 400;

/** 一条 `spans` 段的滑条,起点 1000,每段 400ms。 */
function slider(spans: number) {
  return makeHitObject({
    kind: 'slider',
    startTime: START,
    endTime: START + DURATION * spans,
    spans,
  });
}

function rangeAt(spans: number, time: number, options = DEFAULT_SNAKING) {
  return snakeRangeAt(slider(spans), time, PREEMPT, options);
}

describe('伸展(snake in):窗口是 preempt / 3', () => {
  it('刚出现时长度为 0', () => {
    const r = rangeAt(1, START - PREEMPT);
    expect(r.from).toBe(0);
    expect(r.to).toBe(0);
    expect(r.visible).toBe(false);
  });

  it('窗口过半时伸到一半', () => {
    const r = rangeAt(1, START - PREEMPT + SNAKE_IN_WINDOW / 2);
    expect(r.from).toBe(0);
    expect(r.to).toBeCloseTo(0.5, 9);
  });

  it('窗口结束时伸满,且此后保持整条', () => {
    const justDone = rangeAt(1, START - PREEMPT + SNAKE_IN_WINDOW);
    expect(justDone.to).toBe(1);

    // 之后到 startTime 之前都该是完整的一条 —— 剩下三分之二的 preempt 在等着被点
    const waiting = rangeAt(1, START - 1);
    expect(waiting.from).toBe(0);
    expect(waiting.to).toBe(1);
  });

  it('⚠️ 伸展窗口是 preempt/3 而不是 preempt —— 用整个 preempt 会慢三倍', () => {
    // 走完整个 preempt 的三分之一时就该满了;若实现里写成 preempt,这里只有 1/3
    expect(rangeAt(1, START - PREEMPT + SNAKE_IN_WINDOW).to).toBe(1);
    // 而在窗口的三分之一处应当只有 1/3(用来区分两种写法)
    expect(rangeAt(1, START - PREEMPT + SNAKE_IN_WINDOW / 3).to).toBeCloseTo(1 / 3, 9);
  });

  it('关掉伸展 → 一出现就是整条', () => {
    const r = rangeAt(1, START - PREEMPT, { snakingIn: false, snakingOut: true });
    expect(r.to).toBe(1);
  });
});

describe('收缩(snake out):单向滑条', () => {
  it('球走到一半时,头部那一半已被抹除', () => {
    const r = rangeAt(1, START + DURATION / 2);
    expect(r.from).toBeCloseTo(0.5, 9);
    expect(r.to).toBe(1);
  });

  it('走到末尾时整条消失', () => {
    const r = rangeAt(1, START + DURATION);
    expect(r.visible).toBe(false);
  });

  it('关掉收缩 → 走完仍是整条', () => {
    const r = rangeAt(1, START + DURATION / 2, { snakingIn: true, snakingOut: false });
    expect(r.from).toBe(0);
    expect(r.to).toBe(1);
  });

  it('区间随时间单调收缩,不回弹', () => {
    let previous = -1;
    for (let t = START; t <= START + DURATION; t += 10) {
      const { from } = rangeAt(1, t);
      expect(from, `t=${t}`).toBeGreaterThanOrEqual(previous);
      previous = from;
    }
    expect(previous).toBeCloseTo(1, 6);
  });
});

describe('🔒 收缩只发生在最后一个 span —— 这是 repeat 滑条的关键', () => {
  /**
   * `if (span >= slider.SpanCount() - 1)` 这个门。
   *
   * 少了它,repeat 滑条每走完一段都会抹一次路径然后重新出现 —— 而 osu 里
   * 中间那些来回是**整条常驻**的,只有最后一次重复之后才抹除。
   */
  it('两段滑条:第一段进行中保持整条', () => {
    // completion 0.25 → span 0,而 spans-1 = 1,所以不进收缩分支
    const r = rangeAt(2, START + DURATION * 0.5);
    expect(r.from).toBe(0);
    expect(r.to).toBe(1);
  });

  it('两段滑条:折返点仍是整条', () => {
    // completion = 0.5 → span 1(最后一段,奇数),ProgressAt = 1 ⇒ [0, 1]
    const r = rangeAt(2, START + DURATION);
    expect(r.from).toBe(0);
    expect(r.to).toBeCloseTo(1, 9);
  });

  it('两段滑条:最后一段是**向头部**收缩(奇 span)', () => {
    // 最后一段走一半 → ProgressAt 自带反转,给 0.5 ⇒ [0, 0.5]
    const r = rangeAt(2, START + DURATION * 1.5);
    expect(r.from).toBe(0);
    expect(r.to).toBeCloseTo(0.5, 9);
  });

  it('三段滑条:中间那段保持整条,最后一段才收缩', () => {
    // completion ≈ 0.5 → span 1,不是最后一段(spans-1 = 2)⇒ 整条
    const middle = rangeAt(3, START + DURATION * 1.5);
    expect(middle.from).toBe(0);
    expect(middle.to).toBe(1);

    // completion ≈ 0.833 → span 2(最后一段,偶数)⇒ 从头部收缩
    const lastSpan = rangeAt(3, START + DURATION * 2.5);
    expect(lastSpan.from).toBeCloseTo(0.5, 9);
    expect(lastSpan.to).toBe(1);
  });

  it('任意段数走到末尾都完全消失', () => {
    for (const spans of [1, 2, 3, 4, 5]) {
      const r = rangeAt(spans, START + DURATION * spans);
      expect(r.visible, `spans=${spans}`).toBe(false);
    }
  });

  it('收缩方向随最后一段的奇偶交替 —— 奇数向头,偶数向尾', () => {
    // 最后一段走到 60% 处采样
    for (const spans of [1, 2, 3, 4]) {
      const t = START + DURATION * (spans - 1 + 0.6);
      const r = rangeAt(spans, t);
      const lastSpanIsOdd = (spans - 1) % 2 === 1;

      if (lastSpanIsOdd) {
        // 向头部收缩:起点钉在 0,终点往回缩
        expect(r.from, `spans=${spans}`).toBe(0);
        expect(r.to, `spans=${spans}`).toBeLessThan(1);
      } else {
        // 向尾部收缩:终点钉在 1,起点往前推
        expect(r.from, `spans=${spans}`).toBeGreaterThan(0);
        expect(r.to, `spans=${spans}`).toBe(1);
      }
    }
  });
});

describe('边界与退化情形', () => {
  it('完全在视觉窗口之前 → 不可见', () => {
    expect(rangeAt(1, START - PREEMPT - 100).visible).toBe(false);
  });

  it('区间永远是 from <= to —— 源码 setRange 会交换', () => {
    // 极短滑条:收缩已推进而伸展还没走完,两者可能反过来。
    // 这里扫一遍时间轴,断言不变式成立
    const short = makeHitObject({ kind: 'slider', startTime: START, endTime: START + 5, spans: 1 });
    for (let t = START - PREEMPT; t <= START + 50; t += 1) {
      const r = snakeRangeAt(short, t, PREEMPT);
      expect(r.from, `t=${t}`).toBeLessThanOrEqual(r.to);
    }
  });

  it('endTime == startTime 的退化滑条不产生 NaN', () => {
    const degenerate = makeHitObject({
      kind: 'slider',
      startTime: START,
      endTime: START,
      spans: 1,
    });
    for (const t of [START - PREEMPT, START - 1, START, START + 1]) {
      const r = snakeRangeAt(degenerate, t, PREEMPT);
      expect(Number.isFinite(r.from), `t=${t} from`).toBe(true);
      expect(Number.isFinite(r.to), `t=${t} to`).toBe(true);
    }
  });

  it('preempt 为 0 时不产生 NaN(理论上不会发生,但除法要兜住)', () => {
    const r = snakeRangeAt(slider(1), START, 0);
    expect(Number.isFinite(r.from)).toBe(true);
    expect(Number.isFinite(r.to)).toBe(true);
  });

  it('区间始终落在 [0, 1] 内', () => {
    for (const spans of [1, 2, 3]) {
      for (let t = START - PREEMPT - 50; t <= START + DURATION * spans + 50; t += 7) {
        const r = rangeAt(spans, t);
        expect(r.from, `spans=${spans} t=${t}`).toBeGreaterThanOrEqual(0);
        expect(r.to, `spans=${spans} t=${t}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
