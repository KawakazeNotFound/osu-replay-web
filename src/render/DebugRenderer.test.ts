import { describe, expect, it } from 'vitest';

import { buildReplayFrames } from '../core/replay/frames';
import { createCircleJudgement } from '../core/sim/judgement';
import { stateAt } from '../core/sim/query';
import { makeHitObject, makeSimBeatmap } from '../core/sim/testFixtures';
import { buildTimeline } from '../core/sim/timeline';
import { DebugRenderer } from './DebugRenderer';

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

/** 滑条体折线的两端 x(屏幕坐标)。 */
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
