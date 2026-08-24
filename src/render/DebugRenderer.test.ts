import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildReplayFrames } from '../core/replay/frames';
import { createCircleJudgement } from '../core/sim/judgement';
import { stateAt } from '../core/sim/query';
import { makeHitObject, makeSimBeatmap } from '../core/sim/testFixtures';
import { buildTimeline } from '../core/sim/timeline';
import { radiusFromCS } from '../core/sim/difficulty';
import { DebugRenderer, HIT_FADE_MS } from './DebugRenderer';
import { unpackSkin } from './skin/skinFiles';
import type { ImageDecoder } from './skin/skinTextures';
import { STABLE_MAGIC_SCALE_FACTOR } from './cursor';
import type { CanvasFactory } from './skin/tint';

/**
 * # D8:渲染器的回归测试
 *
 * ## 为什么必须有这个文件
 *
 * 用户在一次实测里报出了**四个**渲染 bug,全是真的,全靠肉眼发现:
 *
 * 1. 泡泡命中后不消失(渲染器从不查 `active.result`)
 * 2. 滑条完全没画
 * 3. approach circle 用硬编码 800ms 当 preempt(AR 高的图收缩过慢)
 * 4. 判定区缩放用了随手写的 0.9,应为 osu 的 `playfield_size_adjust = 0.8`
 *
 * 判定侧有 565 个测试兜着,渲染侧当时是**零**。这就是代价。
 *
 * ## 怎么在没有 canvas 的环境里测
 *
 * vitest 跑在 node 下,没有真 canvas。这里用一个**记录型假 context**:
 * 把所有绘制调用按顺序记下来,然后对调用序列做断言。
 *
 * 这比截图比对弱(测不出观感),但能牢牢锁住上面四类 bug —— 它们全都表现为
 * "该有的调用没有 / 不该有的调用还在 / 参数算错了"。
 */

/** 一次绘制调用。 */
interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
}

/**
 * 记录型 2D context。
 *
 * 属性赋值(`strokeStyle` 等)也记进序列 —— 因为"命中后淡出"是靠 `globalAlpha`
 * 实现的,不记属性就测不出来。
 */
function recordingContext(): { calls: Call[]; ctx: CanvasRenderingContext2D } {
  const calls: Call[] = [];
  const push = (op: string, ...args: unknown[]) => void calls.push({ op, args });

  const target: Record<string, unknown> = {
    save: () => push('save'),
    restore: () => push('restore'),
    beginPath: () => push('beginPath'),
    stroke: () => push('stroke'),
    fill: () => push('fill'),
    arc: (...a: unknown[]) => push('arc', ...a),
    moveTo: (...a: unknown[]) => push('moveTo', ...a),
    lineTo: (...a: unknown[]) => push('lineTo', ...a),
    fillRect: (...a: unknown[]) => push('fillRect', ...a),
    strokeRect: (...a: unknown[]) => push('strokeRect', ...a),
    fillText: (...a: unknown[]) => push('fillText', ...a),
    drawImage: (...a: unknown[]) => push('drawImage', ...a),
    translate: (...a: unknown[]) => push('translate', ...a),
    rotate: (...a: unknown[]) => push('rotate', ...a),
    measureText: () => ({ width: 10 }),
  };

  // 属性写入也要进序列
  const ctx = new Proxy(target, {
    get: (t, key) => t[key as string],
    set: (t, key, value) => {
      t[key as string] = value;
      push(`set:${String(key)}`, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  return { calls, ctx };
}

/** 一个假 canvas,尺寸固定,便于对像素坐标做精确断言。 */
function fakeCanvas(width: number, height: number) {
  const { calls, ctx } = recordingContext();
  const canvas = {
    width,
    height,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as HTMLCanvasElement;

  // DebugRenderer.resize() 会读 devicePixelRatio 并**重写** canvas.width/height
  (globalThis as { window?: unknown }).window ??= {};
  (globalThis as { window: { devicePixelRatio?: number } }).window.devicePixelRatio = 1;

  return { canvas, calls };
}

/** 只取 arc 调用的 (cx, cy, r)。 */
function arcs(calls: readonly Call[]): Array<{ x: number; y: number; r: number }> {
  return calls
    .filter((c) => c.op === 'arc')
    .map((c) => ({ x: c.args[0] as number, y: c.args[1] as number, r: c.args[2] as number }));
}

const OD = 5;
const CS = 4;
const AR = 9;

function difficulty() {
  return {
    circleSize: CS,
    approachRate: AR,
    overallDifficulty: OD,
    drainRate: 5,
    sliderMultiplier: 1.4,
    sliderTickRate: 1,
  };
}

describe('判定区几何', () => {
  it('缩放 = min(W/512, H/384) × 0.8 —— osu 的 playfield_size_adjust', () => {
    // 1024×768 恰好是 4:3,所以 fit = 2,缩放应为 1.6
    // 这正是 lazer 注释里的 "magic ratio":819.2 / 512 = 1.6
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();

    const beatmap = makeSimBeatmap([], { difficulty: difficulty() });
    const timeline = buildTimeline(beatmap, buildReplayFrames([]));
    renderer.draw(timeline, stateAt(timeline, 0));

    // 判定区边框:strokeRect(offsetX, offsetY, 512*scale, 384*scale)
    const border = calls.find((c) => c.op === 'strokeRect');
    expect(border).toBeDefined();

    const w = border!.args[2] as number;
    const h = border!.args[3] as number;

    // scale 应为 2 * 0.8 = 1.6
    expect(w).toBeCloseTo(512 * 1.6, 6);
    expect(h).toBeCloseTo(384 * 1.6, 6);

    // 居中:左右边距相等(默认无垂直偏移,已核 ScalingContainer)
    expect(border!.args[0] as number).toBeCloseTo((1024 - w) / 2, 6);
    expect(border!.args[1] as number).toBeCloseTo((768 - h) / 2, 6);
  });

  it('宽画布用高度作限制维度(4:3 letterbox)', () => {
    const { canvas, calls } = fakeCanvas(2000, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();

    const beatmap = makeSimBeatmap([], { difficulty: difficulty() });
    const timeline = buildTimeline(beatmap, buildReplayFrames([]));
    renderer.draw(timeline, stateAt(timeline, 0));

    const border = calls.find((c) => c.op === 'strokeRect')!;
    // 高受限 → 仍是 768/384 * 0.8 = 1.6
    expect(border.args[3] as number).toBeCloseTo(384 * 1.6, 6);
    // 长宽比保持 4:3,不被拉伸
    expect((border.args[2] as number) / (border.args[3] as number)).toBeCloseTo(4 / 3, 9);
  });
});

describe('命中后泡泡消失(用户报的 bug #1)', () => {
  /** 一个 circle + 一次精确命中它的按下。 */
  function hitScenario() {
    const beatmap = makeSimBeatmap([makeHitObject({ startTime: 1000, x: 256, y: 192 })], {
      difficulty: difficulty(),
    });
    const frames = buildReplayFrames([
      { startTime: 900, x: 256, y: 192, keys: 0 },
      { startTime: 1000, x: 256, y: 192, keys: 1 },
      { startTime: 1100, x: 256, y: 192, keys: 0 },
      { startTime: 3000, x: 256, y: 192, keys: 0 },
    ]);
    return buildTimeline(beatmap, frames, { judge: createCircleJudgement() });
  }

  it('命中前画出圈', () => {
    const timeline = hitScenario();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();

    renderer.draw(timeline, stateAt(timeline, 950));
    // 圈心在判定区中央
    expect(arcs(calls).some((a) => Math.abs(a.x - 512) < 1 && Math.abs(a.y - 384) < 1)).toBe(true);
  });

  it('命中后 alpha 随时间递减 —— 这才是"延迟消失"的真正修复点', () => {
    const timeline = hitScenario();
    const hitTime = timeline.objectResults[0]?.hitTime;
    expect(hitTime).not.toBeNull();

    // ⚠️ 这里踩过一个坑,记下来:第一版断言的是"命中 500ms 后不再画圈",
    // 测试通过了但**是假通过** —— 那时物件早已被上游视觉窗口过滤出
    // activeObjects,渲染器根本没见到它。变异检验(把 `continue` 换成
    // "永不消失")没能让它变红,才暴露出来。
    //
    // 查下来:视觉窗口在 hitTime + 250 之前就结束了,所以 `continue` 那个
    // 分支几乎是死代码。**用户看到的"延迟消失",其实是命中后那 ~150ms 里
    // 圈仍以全不透明画着** —— osu 里是立刻开始淡出的。
    // 所以真正该锁的是 alpha 递减,不是"何时不画"。
    const alphaAt = (t: number): number => {
      const { canvas, calls } = fakeCanvas(1024, 768);
      const renderer = new DebugRenderer(canvas);
      renderer.resize();

      const state = stateAt(timeline, t);
      // 非空洞守卫:这一刻渲染器必须确实拿到了物件
      expect(state.activeObjects.length, `t=${t} 时物件不在视觉窗口内,断言空洞`).toBeGreaterThan(0);
      renderer.draw(timeline, state);

      // 取物件那一段用的 alpha(清屏后的第一个 globalAlpha 写入)
      const idx = calls.findIndex((c) => c.op === 'fillRect');
      const after = calls.slice(idx);
      const set = after.find((c) => c.op === 'set:globalAlpha');
      return set === undefined ? 1 : (set.args[0] as number);
    };

    const early = alphaAt(hitTime! + 20);
    const late = alphaAt(hitTime! + 120);

    expect(early).toBeLessThan(1); // 命中即开始淡出,不是等窗口结束
    expect(late).toBeLessThan(early); // 且单调递减
    expect(late).toBeGreaterThan(0);
  });

  it('命中瞬间到淡出结束之间,globalAlpha 会被调低', () => {
    const timeline = hitScenario();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();

    // 命中后 120ms —— 正好在 240ms 淡出的中间
    renderer.draw(timeline, stateAt(timeline, 1120));

    const alphas = calls
      .filter((c) => c.op === 'set:globalAlpha')
      .map((c) => c.args[0] as number);

    expect(alphas.some((a) => a > 0 && a < 1)).toBe(true);
  });
});

describe('滑条体渲染(用户报的 bug #2)', () => {
  // AR9 → preempt 600,伸展窗口 200ms(preempt/3),起点在 1000-600 = 400
  const SLIDER_START = 1000;
  const SLIDER_END = 1400;
  /** 伸展完成、但滑条还没开始 —— 此刻应该是完整的一条 */
  const FULLY_SNAKED_IN = 700;

  /** 一条水平直线滑条,path 手工塞。 */
  function sliderTimeline(spans = 1) {
    const slider = makeHitObject({
      kind: 'slider',
      startTime: SLIDER_START,
      endTime: SLIDER_START + (SLIDER_END - SLIDER_START) * spans,
      spans,
    });

    // path 是相对起点的偏移。makeHitObject 默认给空路径,这里手工塞一条水平直线。
    // 5 个采样点 ⇒ 进度步长 0.25,足以让 snaking 的子路径里含有内部采样点
    const path = {
      count: 5,
      x: Float32Array.from([0, 25, 50, 75, 100]),
      y: Float32Array.from([0, 0, 0, 0, 0]),
    };
    const withPath = { ...slider, path, x: 100, y: 100, stackedX: 100, stackedY: 100 };

    const beatmap = makeSimBeatmap([withPath], { difficulty: difficulty() });
    return buildTimeline(beatmap, buildReplayFrames([]));
  }

  /** 画一帧,返回调用序列。 */
  function drawSlider(t: number, spans = 1) {
    const timeline = sliderTimeline(spans);
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();
    renderer.draw(timeline, stateAt(timeline, t));
    return calls;
  }

  it('滑条会画出折线(lineTo),不只是一个圈', () => {
    const calls = drawSlider(FULLY_SNAKED_IN);

    // 折线本体
    expect(calls.filter((c) => c.op === 'lineTo').length).toBeGreaterThanOrEqual(2);

    // 滑条体是"直径宽"的粗描边 —— lineWidth 应达到 2×半径量级
    const widths = calls.filter((c) => c.op === 'set:lineWidth').map((c) => c.args[0] as number);
    expect(Math.max(...widths)).toBeGreaterThan(60);
  });

  it('路径只建一次,K 遍描边复用 —— 建路径比描边贵', () => {
    const calls = drawSlider(FULLY_SNAKED_IN);

    // 滑条体那一段:很多次 stroke,但 lineTo 只出现一轮
    expect(countBodyStrokes(calls)).toBeGreaterThan(4);

    // 5 个采样点(进度 0/.25/.5/.75/1)、整条可见。两个端点由 pathOffsetAt 精确给出,
    // 中间只取**严格落在开区间内**的下标 1/2/3 —— 所以是 moveTo + 3 个内部点
    // + 1 个精确末端 = **4** 个 lineTo。若把 beginPath 放进循环,这里会变成 4×K
    expect(calls.filter((c) => c.op === 'lineTo')).toHaveLength(4);
  });

  /* ---------- snaking:用户报的第二轮问题 ---------- */

  it('伸展中:画出的路径比整条短', () => {
    // 伸展窗口 400~600。t=500 恰好一半
    const half = pathExtent(drawSlider(500));
    const full = pathExtent(drawSlider(FULLY_SNAKED_IN));

    expect(half, '伸展到一半时应比整条短').toBeLessThan(full * 0.75);
    expect(half).toBeGreaterThan(0);
  });

  it('伸展是从头部往外长 —— 起点不动,终点前进', () => {
    const early = pathEnds(drawSlider(450));
    const later = pathEnds(drawSlider(550));

    // 起点钉在滑条头
    expect(later.startX).toBeCloseTo(early.startX, 6);
    // 终点往前推
    expect(later.endX).toBeGreaterThan(early.endX);
  });

  it('🔒 收缩:球划过之后头部那一段消失 —— 起点跟着球前进', () => {
    // 单向滑条 1000→1400。取 1100 与 1300 两个时刻
    const earlier = pathEnds(drawSlider(1100));
    const later = pathEnds(drawSlider(1300));

    // 终点钉在滑条尾
    expect(later.endX).toBeCloseTo(earlier.endX, 6);
    // 起点前进 —— 这就是"划过的路径被抹除"
    expect(later.startX).toBeGreaterThan(earlier.startX);
  });

  it('🔒 走到末尾时滑条体不再画出 —— 只剩滑条球那个圈', () => {
    const atEnd = drawSlider(SLIDER_END);

    // 非空洞守卫:这一刻物件必须还在视觉窗口里,否则测的是上游过滤而不是 snaking
    const timeline = sliderTimeline();
    expect(stateAt(timeline, SLIDER_END).activeObjects.length).toBeGreaterThan(0);

    // 滑条体是唯一会产生 lineTo 的东西(圈与球都是 arc)
    expect(atEnd.filter((c) => c.op === 'lineTo')).toHaveLength(0);
  });

  it('🔒 repeat 滑条:中间那一段不收缩(整条常驻)', () => {
    // 两段滑条 1000→1800。第一段进行中(t=1200)应当是整条
    const midFirstSpan = pathExtent(drawSlider(1200, 2));
    const reference = pathExtent(drawSlider(FULLY_SNAKED_IN, 2));

    expect(midFirstSpan, '第一段进行中不该收缩').toBeCloseTo(reference, 4);
  });

  it('🔒 repeat 滑条:最后一段才收缩,且方向朝头部', () => {
    // 两段滑条,最后一段(奇数 span)→ 区间 [0, spanProgress],终点往回缩
    const earlier = pathEnds(drawSlider(1500, 2));
    const later = pathEnds(drawSlider(1700, 2));

    // 起点钉在滑条头(不是尾)
    expect(later.startX).toBeCloseTo(earlier.startX, 6);
    // 终点往头部方向退
    expect(later.endX).toBeLessThan(earlier.endX);
  });

  it('🔒 K 遍描边的 lineWidth 严格递减 —— 这是"用绘制顺序模拟深度测试"的前提', () => {
    // osu 的滑条体靠深度测试保证"每像素只被距中心线最近的那级着色"。
    // canvas2d 没有深度缓冲,改用**由宽到窄**的绘制顺序等价替代:
    // 越窄(越靠中心)的遍越晚画,于是每像素的赢家就是最靠中心的那一级。
    // 顺序一旦反了或乱了,这个等价立刻失效 —— 而肉眼只会觉得"颜色有点怪"。
    const calls = drawSlider(FULLY_SNAKED_IN);
    const widths = bodyWidths(calls);

    // 非空洞守卫:必须真的有多级,否则下面的单调性断言是空的
    expect(widths.length, '滑条体没有分级,断言空洞').toBeGreaterThan(4);

    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!, `第 ${i} 级不应比第 ${i - 1} 级宽`).toBeLessThan(widths[i - 1]!);
    }
  });

  it('🔒 每一级的颜色都是不透明的 —— 否则自相交会叠亮', () => {
    // 这条是整个方案的核心:levels 之间**不能**靠 alpha 混合,
    // 否则滑条自己交叉的地方会累积出更亮的一块(osu 里不会)。
    const calls = drawSlider(FULLY_SNAKED_IN);
    const styles = bodyStyles(calls);

    expect(styles.length, '滑条体没有描边,断言空洞').toBeGreaterThan(4);

    for (const s of styles) {
      expect(s, `滑条体第 N 级用了半透明色:${s}`).not.toMatch(/rgba|hsla/);
      expect(s).toMatch(/^rgb\(/);
    }
  });

  it('横截面从边缘到中心逐渐变淡 —— 中心比边缘更透,这是"管道"观感', () => {
    // webosu 的实测常数:内边缘 alpha 0.8 → 中心 0.3(RGB 恒定)。
    // 我们把 alpha 预合成到判定区背景上,所以"更透"表现为**更接近背景色**。
    // 曾经把它写反(中心近乎不透明的深色),观感差得很明显。
    const calls = drawSlider(FULLY_SNAKED_IN);
    const styles = bodyStyles(calls);
    const lum = (css: string) => {
      const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
      expect(m, `解析不出颜色:${css}`).not.toBeNull();
      return Number(m![1]) + Number(m![2]) + Number(m![3]);
    };

    // 跳过最外圈的边框段(边框是白色,亮度另算),比较轨道色区间的两端
    const mid = styles[Math.floor(styles.length * 0.3)]!;
    const centre = styles[styles.length - 1]!;

    // 背景是极暗的 #0f0f14(亮度 50),所以"更透" ⇒ 亮度更低
    expect(lum(centre), `中心 ${centre} 应比内侧 ${mid} 更接近背景`).toBeLessThan(lum(mid));
  });
});

describe('滑条头的命中动画(用户报的 bug #3)', () => {
  /**
   * 用户实测:「原版滑条头部被点击之后也是有被点击的效果的,而不是愣在原地」。
   *
   * 核过 `DrawableSliderHead.cs`:它**没有**覆写 `UpdateHitStateTransforms`,
   * 所以滑条头与普通圈的命中动画**完全一样**(240ms 淡出 + 扩散到 1.4 倍)。
   * 我们之前用 `object.kind === 'circle'` 把这个动画挡掉了。
   *
   * 难点在于滑条头淡出**不能把滑条体一起带走** —— 体的生死由 snaking 决定。
   */
  const START = 1000;
  const END = 1800;

  /** 一条滑条 + 一次精确命中它头部的按下。 */
  function hitSliderTimeline() {
    const path = {
      count: 5,
      x: Float32Array.from([0, 25, 50, 75, 100]),
      y: Float32Array.from([0, 0, 0, 0, 0]),
    };
    const slider = {
      ...makeHitObject({ kind: 'slider', startTime: START, endTime: END, spans: 1 }),
      path,
      x: 100,
      y: 100,
      stackedX: 100,
      stackedY: 100,
    };

    const beatmap = makeSimBeatmap([slider], { difficulty: difficulty() });
    // 光标停在滑条头上并在 startTime 按下 —— 头会被判成 Great
    const frames = buildReplayFrames([
      { startTime: 900, x: 100, y: 100, keys: 0 },
      { startTime: START, x: 100, y: 100, keys: 1 },
      { startTime: END, x: 100, y: 100, keys: 1 },
      { startTime: END + 200, x: 100, y: 100, keys: 0 },
    ]);
    return buildTimeline(beatmap, frames, { judge: createCircleJudgement() });
  }

  function draw(t: number) {
    const timeline = hitSliderTimeline();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();
    renderer.draw(timeline, stateAt(timeline, t));
    return calls;
  }

  it('头确实被判成命中了 —— 非空洞前提', () => {
    const timeline = hitSliderTimeline();
    // 滑条的 objectResults.hitTime 保留的是**头**的命中时刻(judgement.ts:573)
    expect(timeline.objectResults[0]?.hitTime).not.toBeNull();
    expect(timeline.objectResults[0]?.hitTime).toBeCloseTo(START, 0);
  });

  it('🔒 头命中后圈会扩散 —— 半径超过静止半径', () => {
    const head = screenOf(100, 100);
    const before = headArcRadius(draw(START - 50), head);
    const during = headArcRadius(draw(START + 120), head);

    expect(during, '命中后头圈应比静止时大').toBeGreaterThan(before);
    // ScaleTo(1.4) ⇒ 上限是 1.4 倍
    expect(during).toBeLessThanOrEqual(before * 1.4 + 0.01);
  });

  it('🔒 头命中后 240ms 内不再画头圈,但滑条体仍在', () => {
    const after = draw(START + HIT_FADE_MS + 10);

    // 非空洞守卫:物件必须还在视觉窗口里
    const timeline = hitSliderTimeline();
    expect(stateAt(timeline, START + HIT_FADE_MS + 10).activeObjects.length).toBeGreaterThan(0);

    const region = firstObjectCalls(after);
    // 滑条体还在画(有 lineTo)—— 这是本次改动的关键:头淡完不能把体带走
    expect(region.filter((c) => c.op === 'lineTo').length, '滑条体被头的淡出带走了').toBeGreaterThan(
      0,
    );

    // 而头圈不该再画:物件位置上没有 arc(球在别处,approach 早过了)
    const head = screenOf(100, 100);
    const atHead = arcs(region).filter(
      (a) => Math.abs(a.x - head.x) < 0.5 && Math.abs(a.y - head.y) < 0.5,
    );
    expect(atHead, '头淡完之后还在画头圈').toHaveLength(0);
  });

  it('🔒 滑条体的 alpha 不跟着头一起淡出', () => {
    // 头淡出到一半时(t=0.5 ⇒ head.alpha=0.5),滑条体用的 alpha 应该仍是 1
    const region = firstObjectCalls(draw(START + 120));

    const lastLineTo = region.reduce((acc, c, i) => (c.op === 'lineTo' ? i : acc), -1);
    expect(lastLineTo, '没画滑条体').toBeGreaterThan(0);

    // ⚠️ 这里踩过一次:原先在**整帧**里找最后一个 lineTo,但**光标拖尾也用 lineTo**
    // 且画在物件之后,于是把头的 globalAlpha = 0.5 也划进来了,测出 0.5。
    // (之前的 snaking 测试没踩到,是因为它们用空帧序列,drawTrail 直接 return 了)
    const bodyAlpha = region
      .slice(0, lastLineTo)
      .filter((c) => c.op === 'set:globalAlpha')
      .pop();

    expect(bodyAlpha, '滑条体没设 globalAlpha').toBeDefined();
    expect(bodyAlpha!.args[0] as number, '滑条体的 alpha 被头的淡出污染了').toBeCloseTo(1, 6);
  });

  it('扩散用 Easing.Out(先快后慢),不是线性', () => {
    const head = screenOf(100, 100);
    const base = headArcRadius(draw(START - 50), head);
    const at25 = headArcRadius(draw(START + HIT_FADE_MS * 0.25), head);

    // OutQuad:t=0.25 → 0.25*(2-0.25) = 0.4375,已经走完 43.75%
    // 线性只会走 25%。取中间值 0.34 做判据,足以区分两种曲线
    const grown = (at25 - base) / (base * (1.4 - 1));
    expect(grown, `t=0.25 时应已扩散 ~44%(OutQuad)而非 25%(线性),实测 ${grown}`).toBeGreaterThan(
      0.34,
    );
  });
});

describe('皮肤配色接入优先级链', () => {
  /** 造一个只有 skin.ini 的最小 .osk。 */
  function skinWith(comboLines: readonly string[]) {
    const text = ['[Colours]', ...comboLines].join('\n');
    const zipped = zipSync({ 'skin.ini': new TextEncoder().encode(text) });
    const buf = zipped.buffer.slice(
      zipped.byteOffset,
      zipped.byteOffset + zipped.byteLength,
    ) as ArrayBuffer;
    return unpackSkin(buf);
  }

  /** 一张**没有** [Colours] 的谱面 —— 这样皮肤那一层才有机会生效。 */
  function plainTimeline() {
    const beatmap = makeSimBeatmap([makeHitObject({ startTime: 1000, x: 256, y: 192 })], {
      difficulty: difficulty(),
      comboColours: [],
    });
    return buildTimeline(beatmap, buildReplayFrames([]));
  }

  function circleStrokeStyle(calls: readonly Call[]): string {
    // 物件区间里第一个 strokeStyle 就是圈的颜色(滑条体在这条用例里不存在)
    const found = firstObjectCalls(calls).find((c) => c.op === 'set:strokeStyle');
    expect(found, '没找到圈的 strokeStyle').toBeDefined();
    return String(found!.args[0]);
  }

  it('谱面没给颜色时,皮肤的颜色生效', async () => {
    const timeline = plainTimeline();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();
    await renderer.setSkin(skinWith(['Combo1: 11,22,33', 'Combo2: 44,55,66']));
    renderer.draw(timeline, stateAt(timeline, 900));

    // makeHitObject 默认 comboIndex = 1(1-based),皮肤配色用 comboIndex ⇒ 取下标 1
    expect(circleStrokeStyle(calls)).toBe('rgb(44, 55, 66)');
  });

  it('没有皮肤时落到 osu 默认四色', () => {
    const timeline = plainTimeline();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();
    renderer.draw(timeline, stateAt(timeline, 900));

    // DEFAULT_COMBO_COLOURS[1] = (0, 202, 0)
    expect(circleStrokeStyle(calls)).toBe('rgb(0, 202, 0)');
  });

  it('🔒 换皮肤会让配色表失效 —— 记忆化最容易漏的一步', async () => {
    const timeline = plainTimeline();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();

    await renderer.setSkin(skinWith(['Combo1: 1,1,1', 'Combo2: 2,2,2']));
    renderer.draw(timeline, stateAt(timeline, 900));
    const before = circleStrokeStyle(calls.slice(lastFillRect(calls)));

    // 同一个 beatmap 换皮肤:配色表的记忆化键是 beatmap,若不显式作废就会用旧颜色
    await renderer.setSkin(skinWith(['Combo1: 9,9,9', 'Combo2: 8,8,8']));
    renderer.draw(timeline, stateAt(timeline, 900));
    const after = circleStrokeStyle(calls.slice(lastFillRect(calls)));

    expect(before).toBe('rgb(2, 2, 2)');
    expect(after, '换了皮肤但颜色没变 —— 配色表没作废').toBe('rgb(8, 8, 8)');
  });

  it('卸载皮肤后回到默认四色', async () => {
    const timeline = plainTimeline();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();

    await renderer.setSkin(skinWith(['Combo1: 1,1,1', 'Combo2: 2,2,2']));
    renderer.draw(timeline, stateAt(timeline, 900));

    await renderer.setSkin(null);
    renderer.draw(timeline, stateAt(timeline, 900));

    expect(circleStrokeStyle(calls.slice(lastFillRect(calls)))).toBe('rgb(0, 202, 0)');
  });

  it('🔒 谱面自带 [Colours] 时压过皮肤', async () => {
    // 优先级链:谱面 → 皮肤 → 默认。四张真实 fixture 全都有 [Colours],
    // 所以这条是实际最常走的分支
    const beatmap = makeSimBeatmap([makeHitObject({ startTime: 1000, x: 256, y: 192 })], {
      difficulty: difficulty(),
      comboColours: [
        { r: 100, g: 100, b: 100 },
        { r: 200, g: 200, b: 200 },
      ],
    });
    const timeline = buildTimeline(beatmap, buildReplayFrames([]));

    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();
    await renderer.setSkin(skinWith(['Combo1: 1,1,1', 'Combo2: 2,2,2']));
    renderer.draw(timeline, stateAt(timeline, 900));

    expect(circleStrokeStyle(calls)).toBe('rgb(200, 200, 200)');
  });
});

describe('皮肤贴图绘制路径', () => {
  /**
   * ## 为什么这一组必须存在
   *
   * 贴图路径最容易出的两类错都**不会**报错,只会"看起来有点怪":
   * 1. 尺寸换算错(整体大 1.6 倍 / 大一倍),容易被当成皮肤风格
   * 2. 某个组件静默退回线框(名字写错、名单漏加),表现为"那个部件一直是线框"
   *
   * 所以这里断言"确实发出了 drawImage"以及"确实用了带贴图的那条分支"。
   */
  const START = 1000;

  /** 造一个带贴图的皮肤。`files` 的值只需非空,解码由假解码器负责。 */
  function skinWithImages(files: readonly string[], ini = '') {
    const entries: Record<string, Uint8Array> = {
      'skin.ini': new TextEncoder().encode(ini),
    };
    for (const f of files) entries[f] = new Uint8Array([1, 2, 3]);

    const zipped = zipSync(entries);
    return unpackSkin(
      zipped.buffer.slice(
        zipped.byteOffset,
        zipped.byteOffset + zipped.byteLength,
      ) as ArrayBuffer,
    );
  }

  /** 假解码器:128×128 的 SD 贴图 —— 恰好该画成 2 × Radius。 */
  const decode: ImageDecoder = async () =>
    ({ width: 128, height: 128 }) as never;

  /** 假离屏画布:染色不需要真 canvas。 */
  const makeCanvas: CanvasFactory = (width, height) => ({
    canvas: { width, height } as unknown as CanvasImageSource & {
      width: number;
      height: number;
    },
    ctx: new Proxy({} as Record<string, unknown>, {
      get: (t, k) => t[k as string] ?? (() => undefined),
      set: (t, k, v) => {
        t[k as string] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D,
  });

  function timelineWithCircle() {
    const beatmap = makeSimBeatmap([makeHitObject({ startTime: START, x: 256, y: 192 })], {
      difficulty: difficulty(),
    });
    return buildTimeline(beatmap, buildReplayFrames([]));
  }

  async function drawWith(files: readonly string[], t: number, ini = '') {
    const timeline = timelineWithCircle();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();
    await renderer.setSkin(skinWithImages(files, ini), { decode, makeCanvas });
    renderer.draw(timeline, stateAt(timeline, t));
    return calls;
  }

  it('🔒 有 hitcircle 贴图时改走 drawImage,不再画线框 arc', async () => {
    const calls = await drawWith(['hitcircle.png'], START - 50);
    const region = firstObjectCalls(calls);

    expect(region.filter((c) => c.op === 'drawImage').length).toBeGreaterThan(0);

    // 圈体不该再有 arc(approach circle 在另一趟,不在这个区间里)
    const head = screenOf(256, 192);
    const atHead = arcs(region).filter(
      (a) => Math.abs(a.x - head.x) < 0.5 && Math.abs(a.y - head.y) < 0.5,
    );
    expect(atHead, '有贴图了还在画线框圈').toHaveLength(0);
  });

  it('🔒 尺寸 = 2 × Radius —— 128×128 SD 贴图的判据', async () => {
    const calls = await drawWith(['hitcircle.png'], START - 50);
    const draw = firstObjectCalls(calls).find((c) => c.op === 'drawImage')!;

    // 9 参数版:第 8、9 个参数是 dw / dh
    const dw = draw.args[7] as number;
    const radiusPx = radiusFromCS(CS) * TEST_SCALE;

    expect(dw).toBeCloseTo(2 * radiusPx, 6);
  });

  it('🔒 皮肤缺某个组件时**只有那个**退回线框', async () => {
    // 只给 hitcircle,不给 approachcircle。圈用贴图,approach 用线框。
    // 判据取"物件位置上、半径大于圈半径"的 arc —— 不能只数 arc 总数,
    // 因为光标也画 arc(这个坑下面那条踩过一次)
    const calls = await drawWith(['hitcircle.png'], START - 300);
    const head = screenOf(256, 192);
    const radiusPx = radiusFromCS(CS) * TEST_SCALE;

    expect(calls.filter((c) => c.op === 'drawImage').length).toBeGreaterThan(0);

    const approachRing = arcs(calls).filter(
      (a) =>
        Math.abs(a.x - head.x) < 0.5 && Math.abs(a.y - head.y) < 0.5 && a.r > radiusPx * 1.5,
    );
    expect(approachRing.length, '缺 approachcircle 时应有线框 approach 环').toBeGreaterThan(0);
  });

  it('🔒 approach circle 画在所有物件之后 —— osu 里它是独立顶层', async () => {
    // OsuPlayfield.cs:74 的 approachCircles ProxyContainer 在 HitObjectContainer 之上。
    //
    // ⚠️ 这条第一版是**空洞**的:我用"第一个 arc 出现在最后一个 drawImage 之后"当判据,
    // 但**光标也画 arc**、且画在物件之后 —— 于是把 drawApproachCircles 整个删掉,
    // 测试依然全绿。变异检验抓到了。
    // 现在给 approachcircle 贴图,按"物件位置上尺寸更大的那次 drawImage"定位它。
    const calls = await drawWith(['hitcircle.png', 'approachcircle.png'], START - 300);
    const radiusPx = radiusFromCS(CS) * TEST_SCALE;

    const draws = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.op === 'drawImage')
      .map(({ c, i }) => ({ i, dw: c.args[7] as number }));

    const circleAt = draws.findIndex((d) => Math.abs(d.dw - 2 * radiusPx) < 1);
    const approachAt = draws.findIndex((d) => d.dw > 2 * radiusPx * 1.5);

    expect(circleAt, '没找到圈体的 drawImage').toBeGreaterThanOrEqual(0);
    expect(approachAt, '没找到 approach circle 的 drawImage').toBeGreaterThanOrEqual(0);
    expect(approachAt, 'approach circle 应在圈体之后').toBeGreaterThan(circleAt);
  });

  it('overlay 也画出来(两个 drawImage)', async () => {
    const calls = await drawWith(['hitcircle.png', 'hitcircleoverlay.png'], START - 50);
    expect(firstObjectCalls(calls).filter((c) => c.op === 'drawImage').length).toBe(2);
  });

  it('🔒 HitCircleOverlayAboveNumber 默认 true —— overlay 画在数字**之上**', async () => {
    // 不给字体贴图 ⇒ 数字走 fillText,便于用调用顺序区分两种叠放
    const calls = await drawWith(
      ['hitcircle.png', 'hitcircleoverlay.png'],
      START - 50,
    );
    const region = firstObjectCalls(calls);

    const textAt = region.findIndex((c) => c.op === 'fillText');
    const lastImageAt = region.reduce((acc, c, i) => (c.op === 'drawImage' ? i : acc), -1);

    expect(textAt, '没画数字').toBeGreaterThanOrEqual(0);
    expect(lastImageAt, 'overlay 应在数字之后').toBeGreaterThan(textAt);
  });

  it('🔒 显式关掉时 overlay 画在数字**之下**', async () => {
    const calls = await drawWith(
      ['hitcircle.png', 'hitcircleoverlay.png'],
      START - 50,
      '[General]\nHitCircleOverlayAboveNumber: 0\n',
    );
    const region = firstObjectCalls(calls);

    const textAt = region.findIndex((c) => c.op === 'fillText');
    const lastImageAt = region.reduce((acc, c, i) => (c.op === 'drawImage' ? i : acc), -1);

    expect(textAt, '没画数字').toBeGreaterThanOrEqual(0);
    expect(lastImageAt, '关掉之后 overlay 应在数字之前').toBeLessThan(textAt);
  });

  it('🔒 拼写错误的 HitCircleOverlayAboveNumer 同样生效 —— 用户皮肤正是这个', async () => {
    // OsuLegacySkinTransformer.cs:317-321 —— lazer 把拼错版当 fallback 一起认。
    // 只认正确拼写的实现会在用户那张皮肤上静默走错分支
    const calls = await drawWith(
      ['hitcircle.png', 'hitcircleoverlay.png'],
      START - 50,
      '[General]\nHitCircleOverlayAboveNumer: 0\n',
    );
    const region = firstObjectCalls(calls);

    const textAt = region.findIndex((c) => c.op === 'fillText');
    const lastImageAt = region.reduce((acc, c, i) => (c.op === 'drawImage' ? i : acc), -1);

    expect(lastImageAt, '拼错的键没被认出来').toBeLessThan(textAt);
  });

  it('🔒 数字用字体贴图时不再走 fillText', async () => {
    const files = ['hitcircle.png', ...Array.from({ length: 10 }, (_, d) => `default-${d}.png`)];
    const calls = await drawWith(files, START - 50);

    expect(calls.filter((c) => c.op === 'fillText')).toHaveLength(0);
    // 圈 + 一位数字 = 至少 2 次 drawImage
    expect(firstObjectCalls(calls).filter((c) => c.op === 'drawImage').length).toBeGreaterThanOrEqual(2);
  });

  it('没有字体贴图时退回 fillText', async () => {
    const calls = await drawWith(['hitcircle.png'], START - 50);
    expect(calls.filter((c) => c.op === 'fillText').length).toBe(1);
  });

  it('🔒 卸载皮肤后完全回到线框', async () => {
    const timeline = timelineWithCircle();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();

    await renderer.setSkin(skinWithImages(['hitcircle.png']), { decode, makeCanvas });
    await renderer.setSkin(null);
    renderer.draw(timeline, stateAt(timeline, START - 50));

    const region = firstObjectCalls(calls.slice(lastFillRect(calls)));
    expect(region.filter((c) => c.op === 'drawImage')).toHaveLength(0);
    expect(arcs(region).length).toBeGreaterThan(0);
  });

  it('🔒 setSkin 未 await 完成时不换皮肤 —— 防止同一时刻两种输出', async () => {
    // 这是核心不变式的守卫:若"边装边画",第一次画到 t 是线框、装完再 seek 回 t
    // 是贴图,同一个 t 出两种结果。所以 setSkin 必须**装完才生效**
    const timeline = timelineWithCircle();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();

    const pending = renderer.setSkin(skinWithImages(['hitcircle.png']), {
      decode,
      makeCanvas,
    });

    // 还没 await —— 此刻必须仍是线框
    renderer.draw(timeline, stateAt(timeline, START - 50));
    expect(calls.filter((c) => c.op === 'drawImage'), '装载中就换皮肤了').toHaveLength(0);

    await pending;
  });
});

describe('光标与拖尾的贴图路径', () => {
  /**
   * ## 为什么这一组值钱
   *
   * 光标那个 **1.6 倍分母**是"要么全对要么全错"的一条:漏了光标就大 1.6 倍,
   * 而"光标偏大"极容易被当成皮肤风格,不会有人怀疑是换算错了。
   * 所以这里断言确切像素尺寸。
   */
  const decode: ImageDecoder = async () => ({ width: 128, height: 128 }) as never;
  const makeCanvas: CanvasFactory = (width, height) => ({
    canvas: { width, height } as unknown as CanvasImageSource & {
      width: number;
      height: number;
    },
    ctx: new Proxy({} as Record<string, unknown>, {
      get: (t, k) => t[k as string] ?? (() => undefined),
      set: (t, k, v) => {
        t[k as string] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D,
  });

  function skinWithImages(files: readonly string[], ini = '') {
    const entries: Record<string, Uint8Array> = {
      'skin.ini': new TextEncoder().encode(ini),
    };
    for (const f of files) entries[f] = new Uint8Array([1, 2, 3]);
    const zipped = zipSync(entries);
    return unpackSkin(
      zipped.buffer.slice(
        zipped.byteOffset,
        zipped.byteOffset + zipped.byteLength,
      ) as ArrayBuffer,
    );
  }

  /** 一条有光标移动与按键的回放。 */
  function cursorTimeline() {
    const beatmap = makeSimBeatmap([], { difficulty: difficulty() });
    const frames = buildReplayFrames([
      { startTime: 900, x: 100, y: 100, keys: 0 },
      { startTime: 1000, x: 200, y: 150, keys: 1 },
      { startTime: 1100, x: 256, y: 192, keys: 0 },
    ]);
    return buildTimeline(beatmap, frames);
  }

  async function drawCursorWith(files: readonly string[], t: number, ini = '') {
    const timeline = cursorTimeline();
    const { canvas, calls } = fakeCanvas(1024, 768);
    const renderer = new DebugRenderer(canvas);
    renderer.resize();
    await renderer.setSkin(skinWithImages(files, ini), { decode, makeCanvas });
    renderer.draw(timeline, stateAt(timeline, t));
    return calls;
  }

  /** 最后一次 drawImage 的目标宽度 —— 光标画在最后。 */
  function lastDrawWidth(calls: readonly Call[]): number {
    const draws = calls.filter((c) => c.op === 'drawImage');
    expect(draws.length, '没有任何 drawImage').toBeGreaterThan(0);
    return draws[draws.length - 1]!.args[7] as number;
  }

  it('🔒 光标尺寸 = display 尺寸 / 1.6 × playfieldScale', async () => {
    // 128px SD 贴图 ⇒ display 128 ⇒ 128 / 1.6 = 80 osu 单位
    // ⚠️ 取 900(还没按键)—— 1100 是松手瞬间,缩放仍停在 1.3,量的就不是裸尺寸了
    const calls = await drawCursorWith(['cursor.png'], 900);
    const expected = (128 / STABLE_MAGIC_SCALE_FACTOR) * TEST_SCALE;

    expect(lastDrawWidth(calls)).toBeCloseTo(expected, 6);
  });

  it('🔒 漏掉 1.6 会大 1.6 倍 —— 明确把两种可能区分开', async () => {
    const calls = await drawCursorWith(['cursor.png'], 900);
    const withFactor = (128 / STABLE_MAGIC_SCALE_FACTOR) * TEST_SCALE;
    const withoutFactor = 128 * TEST_SCALE;

    expect(lastDrawWidth(calls)).toBeCloseTo(withFactor, 6);
    expect(lastDrawWidth(calls)).not.toBeCloseTo(withoutFactor, 1);
  });

  it('cursormiddle 也画,且叠在 cursor 之上', async () => {
    const calls = await drawCursorWith(['cursor.png', 'cursormiddle.png'], 1100);
    // 光标那一段应有两次 drawImage
    const draws = calls.filter((c) => c.op === 'drawImage');
    expect(draws.length).toBeGreaterThanOrEqual(2);
  });

  it('🔒 只有 cursor 受旋转影响,cursormiddle 不转', async () => {
    // LegacyCursor.cs:37-51 —— ExpandTarget 是 cursor,cursormiddle 是兄弟节点。
    // 表现:rotate 调用应恰好被一次 save/restore 包住,且在第一张贴图之前
    const calls = await drawCursorWith(['cursor.png', 'cursormiddle.png'], 1100);

    const rotateAt = calls.findIndex((c) => c.op === 'rotate');
    expect(rotateAt, '默认 CursorRotate 为 true,应有 rotate').toBeGreaterThanOrEqual(0);

    const draws = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.op === 'drawImage')
      .map(({ i }) => i);

    // rotate 之后紧跟第一张(cursor),而 restore 之后才画第二张(cursormiddle)
    const restoreAfterRotate = calls.findIndex((c, i) => i > rotateAt && c.op === 'restore');
    const cursorDraw = draws.find((i) => i > rotateAt)!;
    const middleDraw = draws.find((i) => i > restoreAfterRotate)!;

    expect(cursorDraw).toBeLessThan(restoreAfterRotate);
    expect(middleDraw).toBeGreaterThan(restoreAfterRotate);
  });

  it('🔒 CursorRotate: 0 时不发 rotate', async () => {
    const calls = await drawCursorWith(
      ['cursor.png'],
      1100,
      '[General]\nCursorRotate: 0\n',
    );
    expect(calls.filter((c) => c.op === 'rotate')).toHaveLength(0);
  });

  it('🔒 CursorExpand 生效:按下时比松开时大', async () => {
    // 帧:1000 按下、1100 松开。取 1000+100(涨满)与 1100+100(缩回)
    const pressed = lastDrawWidth(await drawCursorWith(['cursor.png'], 1100));
    const released = lastDrawWidth(await drawCursorWith(['cursor.png'], 1200));

    expect(pressed, '按住 100ms 后应到 1.3 倍').toBeGreaterThan(released * 1.25);
  });

  it('CursorExpand: 0 时按下也不放大', async () => {
    const ini = '[General]\nCursorExpand: 0\n';
    const pressed = lastDrawWidth(await drawCursorWith(['cursor.png'], 1100, ini));
    const released = lastDrawWidth(await drawCursorWith(['cursor.png'], 1200, ini));

    expect(pressed).toBeCloseTo(released, 6);
  });

  it('没有 cursor 贴图时退回自绘圆点', async () => {
    const calls = await drawCursorWith(['hitcircle.png'], 1100);
    // 光标那个 fill 是自绘路径的特征
    expect(calls.filter((c) => c.op === 'fill').length).toBeGreaterThan(0);
  });

  it('🔒 拖尾模式的判据是"提供 cursor 的那层有没有 cursormiddle"', async () => {
    // 有 cursormiddle ⇒ connected ⇒ 加法混合
    const connected = await drawCursorWith(
      ['cursor.png', 'cursormiddle.png', 'cursortrail.png'],
      1100,
    );
    expect(
      connected.some((c) => c.op === 'set:globalCompositeOperation' && c.args[0] === 'lighter'),
      'connected 模式应用加法混合',
    ).toBe(true);

    // 没有 cursormiddle ⇒ disjoint ⇒ 普通混合
    const disjoint = await drawCursorWith(['cursor.png', 'cursortrail.png'], 1100);
    expect(
      disjoint.some((c) => c.op === 'set:globalCompositeOperation' && c.args[0] === 'lighter'),
      'disjoint 模式不该用加法混合',
    ).toBe(false);
  });

  it('拖尾贴图也吃 1.6 分母', async () => {
    const calls = await drawCursorWith(['cursor.png', 'cursortrail.png'], 900);
    const draws = calls.filter((c) => c.op === 'drawImage');
    const expected = (128 / STABLE_MAGIC_SCALE_FACTOR) * TEST_SCALE;

    // 拖尾点与光标都是 128px 贴图 ⇒ 全部同宽
    for (const d of draws) expect(d.args[7] as number).toBeCloseTo(expected, 6);
  });

  it('🔒 同一时刻两次绘制的调用序列逐项相同(含拖尾)', async () => {
    // 拖尾是这条不变式最容易被破坏的地方 —— 若改成"累积数组",倒退就错
    const timeline = cursorTimeline();
    const skin = skinWithImages(['cursor.png', 'cursortrail.png']);

    const a = fakeCanvas(1024, 768);
    const ra = new DebugRenderer(a.canvas);
    ra.resize();
    await ra.setSkin(skin, { decode, makeCanvas });
    for (let t = 900; t <= 1100; t += 20) ra.draw(timeline, stateAt(timeline, t));
    const lastA = a.calls.slice(lastFillRect(a.calls));

    const b = fakeCanvas(1024, 768);
    const rb = new DebugRenderer(b.canvas);
    rb.resize();
    await rb.setSkin(skin, { decode, makeCanvas });
    rb.draw(timeline, stateAt(timeline, 3000));
    rb.draw(timeline, stateAt(timeline, 500));
    rb.draw(timeline, stateAt(timeline, 1100));
    const lastB = b.calls.slice(lastFillRect(b.calls));

    expect(lastB).toEqual(lastA);
  });
});

/** 测试画布尺寸,以及由它推出的判定区变换 —— 与 DebugRenderer.resize() 同一套公式。 */
const CANVAS_W = 1024;
const CANVAS_H = 768;
const TEST_SCALE = Math.min(CANVAS_W / 512, CANVAS_H / 384) * 0.8;

function screenOf(x: number, y: number): { x: number; y: number } {
  return {
    x: (CANVAS_W - 512 * TEST_SCALE) / 2 + x * TEST_SCALE,
    y: (CANVAS_H - 384 * TEST_SCALE) / 2 + y * TEST_SCALE,
  };
}

/**
 * 切出**第一个物件**的绘制区间。
 *
 * `drawHitObjects` 给每个物件包了一层 `save`/`restore`,而 `drawSliderBody` 内部
 * 还有一层嵌套的 save/restore —— 所以要**按深度配对**,不能取"第一个 restore"。
 *
 * 起点锚在判定区边框(`strokeRect`)之后的第一个 `save`:边框之前只有清屏。
 */
function firstObjectCalls(calls: readonly Call[]): Call[] {
  const border = calls.findIndex((c) => c.op === 'strokeRect');
  const start = calls.findIndex((c, i) => i > border && c.op === 'save');
  if (start < 0) return [];

  let depth = 0;
  for (let i = start; i < calls.length; i++) {
    if (calls[i]!.op === 'save') depth++;
    else if (calls[i]!.op === 'restore' && --depth === 0) return calls.slice(start, i + 1);
  }
  return calls.slice(start);
}

/**
 * 头圈的 arc 半径。
 *
 * ⚠️ 不能取"第一个 arc" —— **滑条球的 arc 画在头圈之前**,而球半径不随命中缩放,
 * 于是不同时刻测出来完全一样(第一版就是这么假通过的:两个时刻都是 58.39)。
 *
 * 改成按**屏幕位置**筛:头圈画在物件的堆叠位置上。同位置的另一个 arc 是
 * approach circle,它恒 ≥ 头圈半径,且只在未命中时出现(那时 grow == 1),
 * 所以取最小值即为头圈。
 */
function headArcRadius(calls: readonly Call[], at: { x: number; y: number }): number {
  const found = arcs(firstObjectCalls(calls)).filter(
    (a) => Math.abs(a.x - at.x) < 0.5 && Math.abs(a.y - at.y) < 0.5,
  );
  expect(found.length, '没找到画在物件位置上的 arc').toBeGreaterThan(0);
  return Math.min(...found.map((a) => a.r));
}
function pathEnds(calls: readonly Call[]): { startX: number; endX: number } {
  const move = calls.find((c) => c.op === 'moveTo');
  const lineTos = calls.filter((c) => c.op === 'lineTo');
  expect(move, '没有找到滑条体的 moveTo').toBeDefined();
  expect(lineTos.length, '没有找到滑条体的 lineTo').toBeGreaterThan(0);

  return {
    startX: move!.args[0] as number,
    endX: lineTos[lineTos.length - 1]!.args[0] as number,
  };
}

/** 滑条体折线的水平跨度 —— 测试用的是水平直线滑条,所以这就是可见长度。 */
function pathExtent(calls: readonly Call[]): number {
  const { startX, endX } = pathEnds(calls);
  return Math.abs(endX - startX);
}

/** 滑条体那一段的 lineWidth 序列。 */
function bodyWidths(calls: readonly Call[]): number[] {
  return bodyCalls(calls)
    .filter((c) => c.op === 'set:lineWidth')
    .map((c) => c.args[0] as number);
}

/** 同上,取 strokeStyle 序列。 */
function bodyStyles(calls: readonly Call[]): string[] {
  return bodyCalls(calls)
    .filter((c) => c.op === 'set:strokeStyle')
    .map((c) => String(c.args[0]));
}

function countBodyStrokes(calls: readonly Call[]): number {
  return bodyCalls(calls).filter((c) => c.op === 'stroke').length;
}

/**
 * 切出滑条体的绘制区间。
 *
 * 滑条体的绘制形状是:`save → beginPath/moveTo/lineTo… → {K 遍 stroke} → restore`,
 * 之后才是滑条球。所以以**最后一个 `lineTo`** 为起点、**其后第一个 `restore`** 为终点。
 *
 * ⚠️ 这里踩过一次:第一版用"其后第一个 `arc`"当终点,结果把滑条球的
 * `strokeStyle`/`lineWidth` 赋值也划进来了(它们在球自己的 `arc` **之前**),
 * 于是 `#ffdd55` 混进颜色断言、`3.2` 破坏了宽度单调性。`restore` 才是干净的边界。
 */
function bodyCalls(calls: readonly Call[]): Call[] {
  const lastLineTo = calls.reduce((acc, c, i) => (c.op === 'lineTo' ? i : acc), -1);
  if (lastLineTo < 0) return [];

  const restoreAfter = calls.findIndex((c, i) => i > lastLineTo && c.op === 'restore');
  return calls.slice(lastLineTo, restoreAfter < 0 ? calls.length : restoreAfter);
}

describe('🔒 核心约束:正放到达 == 直接 seek 到达', () => {
  /**
   * 这是全文件最有价值的一条。
   *
   * 「渲染层不得持有跨帧可变状态」是本项目帧级 scrub 能成立的**唯一**前提。
   * 一旦有人图省事在渲染器里存个"命中动画计时器"或"拖尾数组",这条就会失败,
   * 而肉眼很难发现(顺序播放时看起来完全正常)。
   */
  it('同一时刻的绘制调用序列逐项相同', () => {
    const beatmap = makeSimBeatmap(
      [
        makeHitObject({ startTime: 1000, x: 100, y: 100 }),
        makeHitObject({ startTime: 1400, x: 300, y: 200 }),
        makeHitObject({ startTime: 1800, x: 200, y: 300 }),
      ],
      { difficulty: difficulty() },
    );
    const frames = buildReplayFrames([
      { startTime: 900, x: 100, y: 100, keys: 0 },
      { startTime: 1000, x: 100, y: 100, keys: 1 },
      { startTime: 1100, x: 200, y: 150, keys: 0 },
      { startTime: 1400, x: 300, y: 200, keys: 1 },
      { startTime: 1500, x: 300, y: 200, keys: 0 },
      { startTime: 1800, x: 200, y: 300, keys: 1 },
      { startTime: 2000, x: 200, y: 300, keys: 0 },
    ]);
    const timeline = buildTimeline(beatmap, frames, { judge: createCircleJudgement() });

    const TARGET = 1550;

    // 路线 A:从头一帧帧正放到 TARGET
    const a = fakeCanvas(1024, 768);
    const rendererA = new DebugRenderer(a.canvas);
    rendererA.resize();
    for (let t = 0; t <= TARGET; t += 50) rendererA.draw(timeline, stateAt(timeline, t));
    const lastFrameA = a.calls.slice(lastFillRect(a.calls));

    // 路线 B:直接 seek 到 TARGET(而且先跳到更晚处再倒回来,模拟真实 scrub)
    const b = fakeCanvas(1024, 768);
    const rendererB = new DebugRenderer(b.canvas);
    rendererB.resize();
    rendererB.draw(timeline, stateAt(timeline, 2500));
    rendererB.draw(timeline, stateAt(timeline, 300));
    rendererB.draw(timeline, stateAt(timeline, TARGET));
    const lastFrameB = b.calls.slice(lastFillRect(b.calls));

    expect(lastFrameB).toEqual(lastFrameA);
  });
});

/** 每帧以 fillRect(清屏) 开头,用它切出"最后一帧"的调用序列。 */
function lastFillRect(calls: readonly Call[]): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]!.op === 'fillRect') return i;
  }
  return 0;
}
