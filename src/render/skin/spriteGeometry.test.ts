import { describe, expect, it } from 'vitest';

import { OBJECT_RADIUS } from '../../core/sim/difficulty';
import { EMPTY_LAYOUT, layoutGlyphs, layoutHitCircleNumber } from './numberLayout';
import {
  CIRCLE_MAX_DISPLAY,
  GLYPH_MAX_DISPLAY,
  HITCIRCLE_TEXT_SCALE,
  displaySize,
  spriteQuad,
} from './spriteGeometry';
import type { SkinSprite } from './skinTextures';

/**
 * # 贴图几何与数字排版
 *
 * 这两块是"照源码画"的地基,而且**全是纯算术** —— 所以能逐项断言确切数值,
 * 比通过渲染器间接测有价值得多。
 */

function sprite(width: number, height: number, scale: 1 | 2 = 1): SkinSprite {
  return {
    image: { width, height } as unknown as CanvasImageSource,
    width,
    height,
    scale,
    layer: '测试',
  };
}

/* ---------------- 尺寸换算 ---------------- */

describe('常数', () => {
  it('OBJECT_RADIUS 是 64', () => {
    expect(OBJECT_RADIUS).toBe(64);
  });

  it('圈类贴图上限 256 = OBJECT_DIMENSIONS × 2', () => {
    // LegacyMainCirclePiece.cs:84 —— maxSize = OBJECT_DIMENSIONS * 2,而 DIMENSIONS = 128
    expect(CIRCLE_MAX_DISPLAY).toBe(256);
  });

  it('字形上限是 256 / 0.8 = 320', () => {
    // OsuLegacySkinTransformer.cs:273 —— MaxSizePerGlyph = OBJECT_DIMENSIONS * 2 / 0.8
    expect(HITCIRCLE_TEXT_SCALE).toBe(0.8);
    expect(GLYPH_MAX_DISPLAY).toBeCloseTo(320, 9);
  });
});

describe('displaySize:原始像素 / ScaleAdjust', () => {
  it('SD 贴图 display 尺寸等于原始尺寸', () => {
    expect(displaySize(sprite(128, 128, 1))).toEqual({ w: 128, h: 128 });
  });

  it('@2x 贴图折半', () => {
    expect(displaySize(sprite(256, 256, 2))).toEqual({ w: 128, h: 128 });
  });
});

describe('🔒 spriteQuad:核心换算 drawW = (w / ScaleAdjust) × (Radius / 64)', () => {
  /**
   * 这一组是整个贴图绘制的地基。写错的表现是"所有东西大一倍/小一半",
   * 而那种错误肉眼容易当成"皮肤就是这样",很难定位。
   */
  it('128×128 的 SD hitcircle 恰好画成 2 × Radius', () => {
    // 这条推论与 CS 无关:128/1 × R/64 = 2R
    for (const r of [20, 32.0131, 45, 60]) {
      const q = spriteQuad(sprite(128, 128, 1), 0, 0, r);
      expect(q.dw, `radius=${r}`).toBeCloseTo(2 * r, 9);
      expect(q.dh, `radius=${r}`).toBeCloseTo(2 * r, 9);
    }
  });

  it('256×256 的 @2x 贴图同样是 2 × Radius —— HD 皮肤不该大一倍', () => {
    const q = spriteQuad(sprite(256, 256, 2), 0, 0, 40);
    expect(q.dw).toBeCloseTo(80, 9);
  });

  it('🔒 256×256 的**非** @2x 贴图会被画成 4 × Radius(不会被缩小)', () => {
    // 这是 osu 的真实行为:尺寸只由 display 尺寸决定,没有"适配到 128"这回事。
    // 我原本以为 LegacyMainCirclePiece 的 `Size = OBJECT_DIMENSIONS` 会把贴图
    // 缩到 128 —— 那是错的,它只是容器自己的盒子
    const q = spriteQuad(sprite(256, 256, 1), 0, 0, 40, null);
    expect(q.dw).toBeCloseTo(160, 9);
  });

  it('以给定点为几何中心', () => {
    const q = spriteQuad(sprite(128, 128, 1), 500, 300, 32);
    expect(q.dx).toBeCloseTo(500 - 32, 9);
    expect(q.dy).toBeCloseTo(300 - 32, 9);
  });

  it('非方形贴图按各自比例,不被拉成方的', () => {
    const q = spriteQuad(sprite(128, 64, 1), 0, 0, 32);
    expect(q.dw).toBeCloseTo(64, 9);
    expect(q.dh).toBeCloseTo(32, 9);
  });

  it('extraScale 参与(命中动画的 grow / 数字的 0.8)', () => {
    const q = spriteQuad(sprite(128, 128, 1), 0, 0, 32, CIRCLE_MAX_DISPLAY, 1.4);
    expect(q.dw).toBeCloseTo(64 * 1.4, 9);
  });
});

describe('🔒 spriteQuad:WithMaximumSize 是**居中裁剪**,不是缩放', () => {
  it('未超限时源矩形是整张图', () => {
    const q = spriteQuad(sprite(128, 128, 1), 0, 0, 32);
    expect({ sx: q.sx, sy: q.sy, sw: q.sw, sh: q.sh }).toEqual({
      sx: 0, sy: 0, sw: 128, sh: 128,
    });
  });

  it('超限时居中切边,且目标尺寸随之变小 —— 而不是把整张图压进上限', () => {
    // 512×512 SD,上限 256 ⇒ 居中裁出 256×256,画成 2×Radius
    const q = spriteQuad(sprite(512, 512, 1), 0, 0, 32);

    expect({ sx: q.sx, sy: q.sy, sw: q.sw, sh: q.sh }).toEqual({
      sx: 128, sy: 128, sw: 256, sh: 256,
    });
    // 裁剪后 display 是 256 ⇒ 256 × 32/64 = 128 = 4×Radius
    expect(q.dw).toBeCloseTo(128, 9);

    // ⚠️ 若误实现成"缩放适配",dw 会是 2×Radius = 64。这条区分两种做法
    expect(q.dw).not.toBeCloseTo(64, 3);
  });

  it('上限乘 ScaleAdjust —— @2x 的裁剪发生在源像素空间', () => {
    // LegacySkinExtensions.cs:117 —— maxSize *= texture.ScaleAdjust
    // 512×512 @2x ⇒ display 256,恰好不超限 ⇒ 不裁
    const q = spriteQuad(sprite(512, 512, 2), 0, 0, 32);
    expect(q.sw).toBe(512);
    expect(q.dw).toBeCloseTo(128, 9);
  });

  it('逐轴取 min —— 怪长宽比的贴图不会被意外拉大', () => {
    // 源码注释:"check per-axis for the minimum dimension to avoid accidentally
    //           inflating textures with weird aspect ratios"
    const q = spriteQuad(sprite(1024, 100, 1), 0, 0, 32);
    expect(q.sw).toBe(256);
    expect(q.sh).toBe(100); // 高没超限,原样保留
  });

  it('maxDisplay 传 null 时不裁', () => {
    const q = spriteQuad(sprite(512, 512, 1), 0, 0, 32, null);
    expect(q.sw).toBe(512);
  });
});

/* ---------------- 数字排版 ---------------- */

/** 造一组等宽字形,便于手算期望值。 */
function digits(count: number, w = 30, h = 40, scale: 1 | 2 = 1) {
  return Array.from({ length: count }, () => sprite(w * scale, h * scale, scale));
}

describe('🔒 数字排版:Spacing = -overlap,方向是反的', () => {
  it('默认 overlap = -2 让字形**分开** 2', () => {
    // GetFontOverlap 的文档:正数让字形靠近,负数分得更开。
    // 默认值 -2 ⇒ Spacing = +2 ⇒ 分开。名字叫 overlap 但默认表现是分开,
    // 这个符号极易搞反
    const layout = layoutGlyphs(digits(2), -2);

    expect(layout.glyphs[0]!.x).toBe(0);
    expect(layout.glyphs[1]!.x).toBe(30 + 2);
    expect(layout.width).toBe(62);
  });

  it('正的 overlap 让字形靠近', () => {
    const layout = layoutGlyphs(digits(2), 10);
    expect(layout.glyphs[1]!.x).toBe(30 - 10);
    expect(layout.width).toBe(50);
  });

  it('🔒 首字符不加 spacing —— 所以一位数完全不受 overlap 影响', () => {
    // currentNewLine 初值为 true(TextBuilder.cs:102)
    for (const overlap of [-2, 0, 50, 150, -100]) {
      const layout = layoutGlyphs(digits(1), overlap);
      expect(layout.glyphs[0]!.x, `overlap=${overlap}`).toBe(0);
      expect(layout.width, `overlap=${overlap}`).toBe(30);
    }
  });
});

describe('🔒 数字排版:总宽是"前缀和的最大值"且钳在 ≥ 0', () => {
  /**
   * `Bounds = ComponentMax(Bounds, currentPos + ...)`,从零起逐字符取最大。
   * 这**不等于**"末字符右边界" —— spacing 是大负数时后面的字形跑到左边,
   * 末字符右边界会比前面的小。
   */
  it('极端 overlap 下总宽由第一个字形决定,不是末字符右边界', () => {
    // 用户真实皮肤的 HitCircleOverlap: 150。字形宽 30 ⇒ x[1] = 30 - 150 = -120
    const layout = layoutGlyphs(digits(2), 150);

    expect(layout.glyphs[1]!.x).toBe(-120);
    // 末字符右边界 = -120 + 30 = -90;取 max 之后仍是第一个字形的 30
    expect(layout.width).toBe(30);
  });

  it('总宽不为负', () => {
    const layout = layoutGlyphs(digits(1, 10), 0);
    expect(layout.width).toBeGreaterThanOrEqual(0);
  });

  it('行高是各字形 display 高的最大值(顶对齐,y 恒为 0)', () => {
    const mixed = [sprite(30, 40), sprite(30, 55)];
    const layout = layoutGlyphs(mixed, 0);

    expect(layout.height).toBe(55);
    for (const g of layout.glyphs) expect(g.y).toBe(0);
  });
});

describe('🔒 overlap 与 display 尺寸同一坐标系 —— @2x 不折半', () => {
  it('同样的 overlap 在 SD 与 @2x 上给出同样的 display 布局', () => {
    // XAdvance = texture.Width / ScaleAdjust(即 display 宽),而 spacing 是原值。
    // 所以两者在 display 坐标系里可比。若错把 overlap 折半,@2x 皮肤的数字间距会不对
    const sd = layoutGlyphs(digits(3, 30, 40, 1), -2);
    const hd = layoutGlyphs(digits(3, 30, 40, 2), -2);

    expect(hd.glyphs.map((g) => g.x)).toEqual(sd.glyphs.map((g) => g.x));
    expect(hd.width).toBe(sd.width);
  });
});

describe('数字排版:缺字形与边界', () => {
  it('🔒 任一字形缺失 → 整串不画', () => {
    // 与 lazer 一致:LegacySkinExtensions.cs:137 用 `prefix-0` 是否存在做整体判据,
    // 缺字形时整个数字不显示,而不是画出半截
    expect(layoutGlyphs([sprite(30, 40), null], -2)).toBe(EMPTY_LAYOUT);
    expect(layoutGlyphs([null], -2)).toBe(EMPTY_LAYOUT);
  });

  it('空数组 → 空布局', () => {
    expect(layoutGlyphs([], -2)).toBe(EMPTY_LAYOUT);
  });

  it('三位数逐项累加', () => {
    const layout = layoutGlyphs(digits(3, 20), 0);
    expect(layout.glyphs.map((g) => g.x)).toEqual([0, 20, 40]);
    expect(layout.width).toBe(60);
  });

  it('每字形独立裁剪到上限', () => {
    const huge = [sprite(400, 400, 1)];
    const layout = layoutGlyphs(huge, 0, 320);
    expect(layout.glyphs[0]!.w).toBe(320);
    expect(layout.glyphs[0]!.h).toBe(320);
  });
});

describe('layoutHitCircleNumber', () => {
  it('用 320 的字形上限', () => {
    const layout = layoutHitCircleNumber([sprite(400, 400, 1)], 0);
    expect(layout.glyphs[0]!.w).toBeCloseTo(GLYPH_MAX_DISPLAY, 9);
  });

  it('宽高**不含** 0.8 —— 那是绘制期的缩放', () => {
    const layout = layoutHitCircleNumber(digits(1, 30, 40), -2);
    expect(layout.width).toBe(30);
    expect(layout.height).toBe(40);
  });
});
