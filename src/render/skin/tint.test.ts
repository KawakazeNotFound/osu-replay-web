import { describe, expect, it } from 'vitest';

import type { Rgb } from '../../core/sim/types';
import type { SkinSprite } from './skinTextures';
import {
  NO_TINTED,
  TINTED_COMPONENTS,
  buildTintedSprites,
  tintSprite,
  type CanvasFactory,
} from './tint';

/**
 * # 染色
 *
 * canvas2d 没有 shader,染色靠 `multiply` 合成。这里测的是**合成配方**:
 * 三步缺一不可,尤其最后那步 `destination-in`(少了它圆圈会变成彩色方块)。
 *
 * 用记录型假 ctx 断言调用序列 —— 与 `DebugRenderer.test.ts` 同一套手法:
 * 没有真 canvas 时,"按序发出了哪些调用"是可以精确断言的。
 */

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
}

/** 记录型离屏画布工厂。 */
function recordingFactory(): { calls: Call[]; sizes: Array<[number, number]>; factory: CanvasFactory } {
  const calls: Call[] = [];
  const sizes: Array<[number, number]> = [];

  const factory: CanvasFactory = (width, height) => {
    sizes.push([width, height]);

    const push = (op: string, ...args: unknown[]) => void calls.push({ op, args });
    const target: Record<string, unknown> = {
      drawImage: (...a: unknown[]) => push('drawImage', ...a),
      fillRect: (...a: unknown[]) => push('fillRect', ...a),
    };

    const ctx = new Proxy(target, {
      get: (t, key) => t[key as string],
      set: (t, key, value) => {
        t[key as string] = value;
        push(`set:${String(key)}`, value);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;

    // canvas 本身只需要能被 drawImage 接受 + 报尺寸
    const canvas = { width, height, __marker: 'offscreen' } as unknown as CanvasImageSource & {
      width: number;
      height: number;
    };

    return { canvas, ctx };
  };

  return { calls, sizes, factory };
}

const IMAGE = { width: 128, height: 128, __marker: 'source' } as unknown as CanvasImageSource;

const SPRITE: SkinSprite = {
  image: IMAGE,
  width: 128,
  height: 128,
  scale: 2,
  layer: '测试皮肤',
};

const RED: Rgb = { r: 255, g: 0, b: 0 };

describe('tintSprite:合成配方', () => {
  it('🔒 三步齐全,且顺序是 原图 → multiply 涂色 → destination-in 抠回', () => {
    const { calls, factory } = recordingFactory();
    tintSprite(SPRITE, RED, factory);

    const ops = calls.map((c) => c.op);

    // 第一步:原图(此时不该有任何 composite 设置 —— 默认 source-over)
    expect(ops[0]).toBe('drawImage');

    // 第二步
    const multiplyAt = ops.indexOf('set:globalCompositeOperation');
    expect(calls[multiplyAt]!.args[0]).toBe('multiply');
    expect(ops.indexOf('fillRect')).toBeGreaterThan(multiplyAt);

    // 第三步:⚠️ 这一步最容易漏 —— 少了它圆形贴图会变成彩色方块
    const restoreAt = ops.lastIndexOf('set:globalCompositeOperation');
    expect(restoreAt, 'destination-in 应在 multiply 之后').toBeGreaterThan(multiplyAt);
    expect(calls[restoreAt]!.args[0]).toBe('destination-in');
    expect(ops.lastIndexOf('drawImage')).toBeGreaterThan(restoreAt);
  });

  it('两次 drawImage 都画的是**原图**,不是离屏结果', () => {
    const { calls, factory } = recordingFactory();
    tintSprite(SPRITE, RED, factory);

    const drawn = calls.filter((c) => c.op === 'drawImage');
    expect(drawn).toHaveLength(2);
    for (const d of drawn) expect(d.args[0]).toBe(IMAGE);
  });

  it('涂的颜色就是传入的 combo 色', () => {
    const { calls, factory } = recordingFactory();
    tintSprite(SPRITE, { r: 18, g: 124, b: 255 }, factory);

    const fill = calls.find((c) => c.op === 'set:fillStyle');
    expect(fill?.args[0]).toBe('rgb(18, 124, 255)');
  });

  it('离屏画布尺寸等于贴图像素尺寸', () => {
    const { sizes, factory } = recordingFactory();
    tintSprite(SPRITE, RED, factory);
    expect(sizes).toEqual([[128, 128]]);
  });

  it('fillRect 覆盖整张图', () => {
    const { calls, factory } = recordingFactory();
    tintSprite(SPRITE, RED, factory);

    const fill = calls.find((c) => c.op === 'fillRect');
    expect(fill?.args).toEqual([0, 0, 128, 128]);
  });

  it('🔒 尺寸与 scale 原样保留 —— 染色不改变几何', () => {
    const { factory } = recordingFactory();
    const tinted = tintSprite(SPRITE, RED, factory);

    expect(tinted.width).toBe(SPRITE.width);
    expect(tinted.height).toBe(SPRITE.height);
    expect(tinted.scale).toBe(SPRITE.scale);
    expect(tinted.layer).toBe(SPRITE.layer);
    // 但 image 换成了离屏结果
    expect(tinted.image).not.toBe(SPRITE.image);
  });
});

describe('buildTintedSprites', () => {
  const sprites = {
    get: (name: string) => (name === 'hitcircle' ? SPRITE : null),
  };

  const COLOURS: readonly Rgb[] = [
    { r: 1, g: 1, b: 1 },
    { r: 2, g: 2, b: 2 },
    { r: 3, g: 3, b: 3 },
  ];

  it('每个组件 × 每个颜色各染一张', () => {
    const { factory } = recordingFactory();
    const tinted = buildTintedSprites(sprites, ['hitcircle'], COLOURS, factory);

    expect(tinted.size).toBe(3);
    for (let i = 0; i < 3; i++) expect(tinted.get('hitcircle', i)).not.toBeNull();
  });

  it('不同颜色下标给出不同的图', () => {
    const { factory } = recordingFactory();
    const tinted = buildTintedSprites(sprites, ['hitcircle'], COLOURS, factory);

    expect(tinted.get('hitcircle', 0)!.image).not.toBe(tinted.get('hitcircle', 1)!.image);
  });

  it('皮肤没提供的组件直接跳过,不炸', () => {
    const { factory } = recordingFactory();
    const tinted = buildTintedSprites(sprites, ['hitcircle', 'nope'], COLOURS, factory);

    expect(tinted.size).toBe(3);
    expect(tinted.get('nope', 0)).toBeNull();
  });

  it('越界的颜色下标返回 null —— 调用方应先取模', () => {
    // 取模规则依赖颜色来源层(谱面用 withOffsets、皮肤用 comboIndex),
    // 那个逻辑在 ComboPalette 里,这里刻意不重复一遍
    const { factory } = recordingFactory();
    const tinted = buildTintedSprites(sprites, ['hitcircle'], COLOURS, factory);

    expect(tinted.get('hitcircle', 3)).toBeNull();
    expect(tinted.get('hitcircle', -1)).toBeNull();
  });

  it('组件名去重', () => {
    const { sizes, factory } = recordingFactory();
    buildTintedSprites(sprites, ['hitcircle', 'hitcircle'], COLOURS, factory);
    // 3 个颜色 × 1 个组件 = 3 张离屏,而不是 6 张
    expect(sizes).toHaveLength(3);
  });

  it('空颜色表 → 什么都不染', () => {
    const { factory } = recordingFactory();
    expect(buildTintedSprites(sprites, ['hitcircle'], [], factory).size).toBe(0);
  });
});

describe('NO_TINTED', () => {
  it('一切返回 null', () => {
    expect(NO_TINTED.get('hitcircle', 0)).toBeNull();
    expect(NO_TINTED.size).toBe(0);
  });
});

describe('TINTED_COMPONENTS', () => {
  it('🔒 只含圈类,不含 overlay', () => {
    // 依据:lazer 里只有 CircleSprite 绑定了 AccentColour,OverlaySprite 没有。
    // 把 overlay 也染上会让边框与高光跟着变色 —— 与 osu 观感明显不同
    for (const n of TINTED_COMPONENTS) expect(n, n).not.toContain('overlay');
    expect(TINTED_COMPONENTS).toContain('hitcircle');
  });

  it('不含滑条球 —— 它由 AllowSliderBallTint 单独控制', () => {
    expect(TINTED_COMPONENTS.some((n) => n.startsWith('sliderb'))).toBe(false);
  });
});
