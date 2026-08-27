import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildReplayFrames } from '../core/replay/frames';
import { radiusFromCS } from '../core/sim/difficulty';
import { createCircleJudgement } from '../core/sim/judgement';
import { stateAt } from '../core/sim/query';
import { makeHitObject, makeSimBeatmap } from '../core/sim/testFixtures';
import { buildTimeline } from '../core/sim/timeline';
import { DebugRenderer } from './DebugRenderer';
import { loadDefaultSkin } from './skin/defaultSkin';
import type { ImageDecoder } from './skin/skinTextures';
import type { CanvasFactory } from './skin/tint';

/**
 * # 端到端:**真实的** `public/skins/default/` 能不能让物件画成贴图
 *
 * ## 为什么单独一个文件
 *
 * 用户实测报告:"只加载了光标和轨迹,泡泡还是原来的样子"。
 * 而当时 840 个测试全绿 —— 因为**每一条皮肤测试都是自己 zip 出来的合成皮肤**,
 * 用的是自己编的文件名。合成皮肤永远"刚好有"被测代码要的那个名字,
 * 于是"组件名对不上真实素材"这类错误一条都测不出来。
 *
 * 这个文件改成:**读真实的 `index.json` 与真实的 png 字节**,只把
 * `createImageBitmap`(浏览器专属)换成假解码器。也就是说除了"图片解码本身",
 * 整条链路都是真的:清单 → 分层查找 → `@2x` 与 `scale` → 组件名决策 →
 * 染色 → 尺寸换算 → `drawImage`。
 *
 * 素材缺失时整组跳过(素材虽然入库,但别人 clone 后可能还没跑 fetch 脚本)。
 */

const SKIN_DIR = join(process.cwd(), 'public', 'skins', 'default');
const hasAssets = existsSync(join(SKIN_DIR, 'index.json'));

/** 从磁盘伺服 `public/skins/default/` —— 模拟 Vite 把它搬到站点根之后的样子。 */
const diskFetch: typeof fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const prefix = '/skins/default/';
  if (!url.startsWith(prefix)) return { ok: false, status: 404 } as Response;

  const path = join(SKIN_DIR, url.slice(prefix.length));
  if (!existsSync(path)) return { ok: false, status: 404 } as Response;

  const bytes = readFileSync(path);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(bytes.toString('utf-8')),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as Response;
}) as typeof fetch;

/**
 * 假解码器。**只伪造尺寸,不伪造存在性** —— 字节是真从磁盘读来的,
 * 所以"文件名对不对""@2x 判得对不对"仍然是真的在被测。
 *
 * 默认皮肤全是 @2x,256×256 是 `hitcircle@2x.png` 的实际尺寸量级;
 * 这里统一给 256 便于手算期望值。
 */
const decode: ImageDecoder = async () => ({ width: 256, height: 256 }) as never;

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

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
}

const CANVAS_W = 1024;
const CANVAS_H = 768;
const TEST_SCALE = Math.min(CANVAS_W / 512, CANVAS_H / 384) * 0.8;
const CS = 4;

function fakeCanvas() {
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

  const ctx = new Proxy(target, {
    get: (t, key) => t[key as string],
    set: (t, key, value) => {
      t[key as string] = value;
      push(`set:${String(key)}`, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  const canvas = {
    width: CANVAS_W,
    height: CANVAS_H,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: CANVAS_W, height: CANVAS_H }),
  } as unknown as HTMLCanvasElement;

  (globalThis as { window?: unknown }).window ??= {};
  (globalThis as { window: { devicePixelRatio?: number } }).window.devicePixelRatio = 1;

  return { canvas, calls };
}

const START = 1000;

/** 一个 circle + 一次命中它的按下,便于同时验命中前与命中后。 */
function scenario() {
  const beatmap = makeSimBeatmap([makeHitObject({ startTime: START, x: 256, y: 192 })], {
    difficulty: {
      circleSize: CS,
      approachRate: 9,
      overallDifficulty: 5,
      drainRate: 5,
      sliderMultiplier: 1.4,
      sliderTickRate: 1,
    },
  });
  const frames = buildReplayFrames([
    { startTime: 800, x: 256, y: 192, keys: 0 },
    { startTime: START, x: 256, y: 192, keys: 1 },
    { startTime: START + 100, x: 256, y: 192, keys: 0 },
  ]);
  return buildTimeline(beatmap, frames, { judge: createCircleJudgement() });
}

/** 装上**真实**默认皮肤的渲染器。 */
async function rendererWithDefaultSkin() {
  const { canvas, calls } = fakeCanvas();
  const renderer = new DebugRenderer(canvas);
  renderer.resize();

  const layer = await loadDefaultSkin('/skins/default', diskFetch);
  await renderer.setDefaultSkinLayer(layer, { decode, makeCanvas });

  return { renderer, calls };
}

describe.skipIf(!hasAssets)('端到端:真实默认皮肤', () => {
  it('清单能从磁盘读出来,且含 hitcircle', async () => {
    const layer = await loadDefaultSkin('/skins/default', diskFetch);
    // 前提检查:后面的断言都靠它
    expect(layer.files.has('hitcircle@2x.png')).toBe(true);
    expect(layer.files.has('cursor@2x.png')).toBe(true);
  });

  it('🔒 物件画成贴图,而不是线框 —— 用户报的正是这条', async () => {
    const timeline = scenario();
    const { renderer, calls } = await rendererWithDefaultSkin();

    renderer.draw(timeline, stateAt(timeline, START - 200));

    expect(calls.filter((c) => c.op === 'drawImage').length, '一次 drawImage 都没有').toBeGreaterThan(0);
  });

  it('🔒 圈体尺寸 = 2 × Radius(256px @2x ⇒ display 128)', async () => {
    const timeline = scenario();
    const { renderer, calls } = await rendererWithDefaultSkin();

    renderer.draw(timeline, stateAt(timeline, START - 200));

    const radiusPx = radiusFromCS(CS) * TEST_SCALE;
    const widths = calls
      .filter((c) => c.op === 'drawImage')
      .map((c) => c.args[7] as number);

    expect(
      widths.some((w) => Math.abs(w - 2 * radiusPx) < 1),
      `没有任何 drawImage 的宽度等于 2×Radius(${(2 * radiusPx).toFixed(1)});实测 ${widths.map((w) => w.toFixed(1)).join(', ')}`,
    ).toBe(true);
  });

  it('🔒 圈内的 combo 数字也画出来了', async () => {
    const timeline = scenario();
    const { renderer, calls } = await rendererWithDefaultSkin();

    renderer.draw(timeline, stateAt(timeline, START - 200));

    // 默认皮肤有 default-0..9,所以数字应该走贴图而**不是** fillText
    expect(calls.filter((c) => c.op === 'fillText'), '数字退回了 canvas 文字').toHaveLength(0);

    // 圈 + overlay + 数字 ⇒ 至少三次 drawImage
    expect(calls.filter((c) => c.op === 'drawImage').length).toBeGreaterThanOrEqual(3);
  });

  it('🔒 approach circle 也走贴图', async () => {
    const timeline = scenario();
    const { renderer, calls } = await rendererWithDefaultSkin();

    // 出现后不久,approach circle 应该还很大
    renderer.draw(timeline, stateAt(timeline, START - 500));

    const radiusPx = radiusFromCS(CS) * TEST_SCALE;
    const widths = calls
      .filter((c) => c.op === 'drawImage')
      .map((c) => c.args[7] as number);

    expect(
      widths.some((w) => w > 2 * radiusPx * 1.5),
      'approach circle 应该明显大于圈体',
    ).toBe(true);
  });

  it('光标与拖尾也在(用户说这两个是好的,作为对照)', async () => {
    const timeline = scenario();
    const { renderer, calls } = await rendererWithDefaultSkin();

    renderer.draw(timeline, stateAt(timeline, START));

    // 默认皮肤有 cursor / cursormiddle / cursortrail
    expect(calls.filter((c) => c.op === 'drawImage').length).toBeGreaterThan(3);
  });

  it('🔒 命中之后圈体消失,但不该整帧空掉', async () => {
    const timeline = scenario();
    const { renderer, calls } = await rendererWithDefaultSkin();

    const hitTime = timeline.objectResults[0]?.hitTime;
    expect(hitTime).not.toBeNull();

    renderer.draw(timeline, stateAt(timeline, hitTime! + 300));

    // 圈已淡完,但光标还在
    expect(calls.filter((c) => c.op === 'drawImage').length).toBeGreaterThan(0);
  });
});
