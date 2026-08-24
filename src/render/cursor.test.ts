import { describe, expect, it } from 'vitest';

import { buildReplayFrames } from '../core/replay/frames';
import {
  APPROACH_FADE_OUT_MS,
  APPROACH_PEAK_ALPHA,
  APPROACH_START_SCALE,
  approachAlphaAt,
  approachScaleAt,
} from './approachCircle';
import {
  CURSOR_EXPAND_MS,
  CURSOR_PRESSED_SCALE,
  CURSOR_REVOLUTION_MS,
  DISJOINT_TRAIL_STEP_MS,
  STABLE_MAGIC_SCALE_FACTOR,
  TRAIL_FADE_MS,
  cursorExpandScaleAt,
  cursorRotationAt,
  disjointTrailTimes,
  trailAlphaAt,
} from './cursor';

/**
 * # approach circle 与光标的时间线
 *
 * 全是纯算术,所以能断言确切数值。这一批修正了三处我原本写错或漏掉的东西:
 * approach circle 的 alpha(完全没做)、"1 倍"的基准、光标的 1.6 倍分母。
 */

const ST = 1000;
const TP = 600; // AR9

describe('approach circle:缩放', () => {
  it('起点 4 倍,终点 1 倍', () => {
    expect(approachScaleAt(ST, TP, ST - TP)).toBeCloseTo(4, 9);
    expect(approachScaleAt(ST, TP, ST)).toBeCloseTo(1, 9);
    expect(APPROACH_START_SCALE).toBe(4);
  });

  it('🔒 线性,不是 easing —— ScaleTo 的默认 easing 是 Easing.None', () => {
    // 半程应恰好是 2.5。若误用 OutQuad 会是 4 - 3*0.75 = 1.75
    expect(approachScaleAt(ST, TP, ST - TP / 2)).toBeCloseTo(2.5, 9);
    // 四分之一处 3.25(线性)vs 2.6875(OutQuad)
    expect(approachScaleAt(ST, TP, ST - TP * 0.75)).toBeCloseTo(3.25, 9);
  });

  it('窗口外被夹住', () => {
    expect(approachScaleAt(ST, TP, ST - TP - 500)).toBeCloseTo(4, 9);
    expect(approachScaleAt(ST, TP, ST + 500)).toBeCloseTo(1, 9);
  });

  it('preempt 为 0 不产生 NaN', () => {
    expect(Number.isFinite(approachScaleAt(ST, 0, ST))).toBe(true);
  });
});

describe('approach circle:alpha(我们原来完全没做)', () => {
  it('出现之前是 0', () => {
    expect(approachAlphaAt(ST, TP, ST - TP - 1, null)).toBe(0);
  });

  it('🔒 淡入的目标是 0.9,不是 1', () => {
    // DrawableHitCircle.cs:196 —— ApproachCircle.FadeTo(0.9f, ...)
    // TimeFadeIn = 400 * min(1, 600/450) = 400;窗口 = min(800, 600) = 600
    // 所以在 ST 时刻恰好淡满
    expect(approachAlphaAt(ST, TP, ST - 1, null)).toBeCloseTo(APPROACH_PEAK_ALPHA, 2);
    expect(APPROACH_PEAK_ALPHA).toBe(0.9);
  });

  it('淡入窗口 = min(2 × TimeFadeIn, TimePreempt)', () => {
    // AR9:TimeFadeIn = 400,2×= 800 > TP=600 ⇒ 取 600(整个 preempt)
    // 半程应是 0.45
    expect(approachAlphaAt(ST, TP, ST - TP / 2, null)).toBeCloseTo(0.45, 6);
  });

  it('高 AR 时淡入窗口由 2×TimeFadeIn 决定', () => {
    // AR10:preempt 450 ⇒ TimeFadeIn = 400 * min(1, 1) = 400,2× = 800 > 450
    // 仍取 preempt。换个更极端的:preempt 2000(理论值)
    // TimeFadeIn = 400 * min(1, 2000/450) = 400,2× = 800 < 2000 ⇒ 取 800
    const preempt = 2000;
    // 出现后 800ms 应淡满
    expect(approachAlphaAt(ST, preempt, ST - preempt + 800, null)).toBeCloseTo(0.9, 6);
    // 400ms 处一半
    expect(approachAlphaAt(ST, preempt, ST - preempt + 400, null)).toBeCloseTo(0.45, 6);
  });

  it('🔒 startTime 起 50ms 淡出 —— 源码注释:"always fade out at the circle\'s start time"', () => {
    expect(approachAlphaAt(ST, TP, ST, null)).toBeCloseTo(0.9, 6);
    expect(approachAlphaAt(ST, TP, ST + APPROACH_FADE_OUT_MS / 2, null)).toBeCloseTo(0.45, 6);
    expect(approachAlphaAt(ST, TP, ST + APPROACH_FADE_OUT_MS, null)).toBe(0);
    expect(APPROACH_FADE_OUT_MS).toBe(50);
  });

  it('🔒 判定即消失(FadeOut 无时长)', () => {
    // 玩家提前 100ms 命中 ⇒ 那一刻起 approach circle 立刻不见
    const hitTime = ST - 100;
    expect(approachAlphaAt(ST, TP, hitTime - 1, hitTime)).toBeGreaterThan(0);
    expect(approachAlphaAt(ST, TP, hitTime, hitTime)).toBe(0);
    expect(approachAlphaAt(ST, TP, hitTime + 1, hitTime)).toBe(0);
  });

  it('miss(hitTime 为 null)时靠 ST+50 那一段自然消失', () => {
    // ArmedState.Miss 走自己的 case、不执行 ApproachCircle.FadeOut(),
    // 但 ST 时刻的 FadeOut(50) 已经把它带走了
    expect(approachAlphaAt(ST, TP, ST + 60, null)).toBe(0);
  });

  it('alpha 恒在 [0, 0.9]', () => {
    for (let t = ST - TP - 100; t <= ST + 200; t += 7) {
      const a = approachAlphaAt(ST, TP, t, null);
      expect(a, `t=${t}`).toBeGreaterThanOrEqual(0);
      expect(a, `t=${t}`).toBeLessThanOrEqual(APPROACH_PEAK_ALPHA);
    }
  });
});

describe('🔒 光标贴图的 1.6 倍分母', () => {
  it('STABLE_MAGIC_SCALE_FACTOR 是 1.6', () => {
    // NonPlayfieldSprite 给 cursor/cursormiddle/cursortrail 额外乘了这个 ScaleAdjust。
    // 漏掉的话光标会大 1.6 倍 —— 而"光标偏大"很容易被当成皮肤风格,不易定位
    expect(STABLE_MAGIC_SCALE_FACTOR).toBe(1.6);
  });

  it('来历自洽:819.2 / 512 = 1.6', () => {
    // OsuPlayfieldAdjustmentContainer.cs:56-64 —— 判定区在 1024×768 参考屏幕下被放大 1.6
    expect(819.2 / 512).toBeCloseTo(STABLE_MAGIC_SCALE_FACTOR, 9);
  });
});

describe('光标旋转', () => {
  it('每 10000ms 一圈', () => {
    expect(CURSOR_REVOLUTION_MS).toBe(10000);
    expect(cursorRotationAt(0)).toBeCloseTo(0, 9);
    expect(cursorRotationAt(2500)).toBeCloseTo(90, 9);
    expect(cursorRotationAt(5000)).toBeCloseTo(180, 9);
  });

  it('每秒 36 度', () => {
    expect(cursorRotationAt(1000)).toBeCloseTo(36, 9);
  });

  it('循环,且负时间(lead-in)也给正角度', () => {
    expect(cursorRotationAt(10000)).toBeCloseTo(0, 6);
    expect(cursorRotationAt(12500)).toBeCloseTo(90, 6);

    const negative = cursorRotationAt(-2500);
    expect(negative).toBeGreaterThanOrEqual(0);
    expect(negative).toBeLessThan(360);
    expect(negative).toBeCloseTo(270, 6);
  });
});

describe('光标按下缩放', () => {
  /** 一串帧:900 未按 → 1000 按 M1 → 1200 松开 → 1400 未按。 */
  const FRAMES = buildReplayFrames([
    { startTime: 900, x: 0, y: 0, keys: 0 },
    { startTime: 1000, x: 0, y: 0, keys: 1 },
    { startTime: 1200, x: 0, y: 0, keys: 0 },
    { startTime: 1400, x: 0, y: 0, keys: 0 },
  ]);

  it('关掉 CursorExpand 时恒为 1(用户皮肤正是 0)', () => {
    for (const t of [900, 1000, 1050, 1300]) {
      expect(cursorExpandScaleAt(FRAMES, t, false), `t=${t}`).toBe(1);
    }
  });

  it('未按下时是 1', () => {
    expect(cursorExpandScaleAt(FRAMES, 950, true)).toBeCloseTo(1, 9);
  });

  it('按下瞬间从 1 起涨', () => {
    expect(cursorExpandScaleAt(FRAMES, 1000, true)).toBeCloseTo(1, 9);
  });

  it('🔒 100ms 后到 1.3', () => {
    expect(CURSOR_PRESSED_SCALE).toBe(1.3);
    expect(CURSOR_EXPAND_MS).toBe(100);
    expect(cursorExpandScaleAt(FRAMES, 1000 + CURSOR_EXPAND_MS, true)).toBeCloseTo(1.3, 6);
  });

  it('🔒 用 Easing.Out(OutQuad),不是线性', () => {
    // t=0.25 → OutQuad 给 0.4375,线性给 0.25
    const s = cursorExpandScaleAt(FRAMES, 1025, true);
    expect(s).toBeCloseTo(1 + 0.3 * 0.4375, 6);
    // 与线性明确区分
    expect(s).not.toBeCloseTo(1 + 0.3 * 0.25, 3);
  });

  it('按住不放保持 1.3', () => {
    expect(cursorExpandScaleAt(FRAMES, 1150, true)).toBeCloseTo(1.3, 6);
  });

  it('松开后 100ms 回到 1', () => {
    expect(cursorExpandScaleAt(FRAMES, 1200 + CURSOR_EXPAND_MS, true)).toBeCloseTo(1, 6);
    expect(cursorExpandScaleAt(FRAMES, 1350, true)).toBeCloseTo(1, 6);
  });

  it('松开中途在 1 与 1.3 之间', () => {
    const mid = cursorExpandScaleAt(FRAMES, 1250, true);
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(1.3);
  });

  it('🔒 多按一个键会**重启**动画', () => {
    // OsuCursorContainer:任意键按下都调 Expand(),而 Expand() 是
    // ScaleTo(1).ScaleTo(1.3, 100) —— 先瞬间归 1 再重新涨。
    // 所以基准是"最近一次新增按键",不是"最近一次从无到有"
    const frames = buildReplayFrames([
      { startTime: 1000, x: 0, y: 0, keys: 1 },
      { startTime: 1200, x: 0, y: 0, keys: 3 }, // 多按一个
    ]);

    // 1200 那一刻应被打回 1
    expect(cursorExpandScaleAt(frames, 1200, true)).toBeCloseTo(1, 6);
    // 而若基准是 1000(错的实现),这里会是 1.3
    expect(cursorExpandScaleAt(frames, 1200, true)).not.toBeCloseTo(1.3, 2);
  });

  it('空帧 / 时间早于首帧不炸', () => {
    expect(cursorExpandScaleAt(buildReplayFrames([]), 1000, true)).toBe(1);
    expect(cursorExpandScaleAt(FRAMES, 0, true)).toBe(1);
  });
});

describe('拖尾:两种模式的常数', () => {
  it('connected 500ms / disjoint 150ms', () => {
    expect(TRAIL_FADE_MS.connected).toBe(500);
    expect(TRAIL_FADE_MS.disjoint).toBe(150);
  });

  it('disjoint 的时间网格是 1000/60', () => {
    expect(DISJOINT_TRAIL_STEP_MS).toBeCloseTo(16.6667, 4);
  });

  it('淡出是线性(FadeExponent = 1)', () => {
    expect(trailAlphaAt(0, 150)).toBeCloseTo(1, 9);
    expect(trailAlphaAt(75, 150)).toBeCloseTo(0.5, 9);
    expect(trailAlphaAt(150, 150)).toBeCloseTo(0, 9);
    expect(trailAlphaAt(200, 150)).toBe(0);
  });
});

describe('🔒 disjoint 拖尾是完全的纯函数', () => {
  it('点落在固定的时间网格上', () => {
    const times = disjointTrailTimes(1000, 150);
    for (const t of times) {
      expect(t / DISJOINT_TRAIL_STEP_MS, `${t} 应在网格上`).toBeCloseTo(
        Math.round(t / DISJOINT_TRAIL_STEP_MS),
        9,
      );
    }
  });

  it('约 9 个点(150 / 16.667)', () => {
    expect(disjointTrailTimes(1000, 150).length).toBe(9);
  });

  it('从新到旧排列,且都在淡出窗口内', () => {
    const times = disjointTrailTimes(1000, 150);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeLessThan(times[i - 1]!);
    }
    for (const t of times) {
      expect(t).toBeLessThanOrEqual(1000);
      expect(1000 - t).toBeLessThan(150);
    }
  });

  it('🔒 同一时刻两次调用结果完全相同 —— scrub 一致性的根据', () => {
    // 这是整条拖尾能做到帧级 scrub 的原因:点集只由 t 决定,不依赖"上一帧画了什么"
    expect(disjointTrailTimes(1234.5, 150)).toEqual(disjointTrailTimes(1234.5, 150));
  });

  it('时间推进时点集平滑滚动,不跳变', () => {
    const a = disjointTrailTimes(1000, 150);
    const b = disjointTrailTimes(1000 + DISJOINT_TRAIL_STEP_MS, 150);

    // 前进一格 ⇒ 新增一个最新点,旧的掉一个
    expect(b[0]!).toBeCloseTo(a[0]! + DISJOINT_TRAIL_STEP_MS, 6);
    expect(b.length).toBe(a.length);
  });

  it('负时间不炸', () => {
    expect(() => disjointTrailTimes(-500, 150)).not.toThrow();
  });
});
