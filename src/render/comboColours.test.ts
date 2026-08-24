import { describe, expect, it } from 'vitest';

import { makeHitObject, makeSimBeatmap } from '../core/sim/testFixtures';
import type { Rgb } from '../core/sim/types';
import {
  DEFAULT_COMBO_COLOURS,
  DEFAULT_SLIDER_BORDER,
  buildComboPalette,
  cssOf,
} from './comboColours';

/**
 * # combo 配色的优先级链与索引不对称
 *
 * 这个文件锁的是一件**从注释里读不出来**的事:取颜色时用哪个索引,
 * 取决于颜色来自哪一层。依据见 `comboColours.ts` 头部的调用链。
 *
 * 之所以值得专门测:这段逻辑没有 ground truth 可对
 * (回放文件不记皮肤,谱面配色也没有"期望输出"可比),
 * 而错了以后的表现只是"颜色有点怪" —— 极难靠肉眼定位。
 */

const RED: Rgb = { r: 255, g: 0, b: 0 };
const GREEN: Rgb = { r: 0, g: 255, b: 0 };
const BLUE: Rgb = { r: 0, g: 0, b: 255 };

/** 造一个只关心两个 combo 索引的物件。 */
function obj(comboIndex: number, comboIndexWithOffsets = comboIndex) {
  return makeHitObject({ comboIndex, comboIndexWithOffsets });
}

describe('优先级链:谱面 → 皮肤 → 默认', () => {
  it('谱面有 [Colours] 时用谱面的', () => {
    const beatmap = makeSimBeatmap([], { comboColours: [RED, GREEN] });
    const palette = buildComboPalette(beatmap, [BLUE]);

    expect(palette.source).toBe('beatmap');
    expect(palette.colours).toEqual([RED, GREEN]);
  });

  it('谱面没给但皮肤给了 → 用皮肤的', () => {
    const beatmap = makeSimBeatmap([], { comboColours: [] });
    const palette = buildComboPalette(beatmap, [BLUE]);

    expect(palette.source).toBe('skin');
    expect(palette.colours).toEqual([BLUE]);
  });

  it('两边都没给 → osu 默认四色', () => {
    const palette = buildComboPalette(makeSimBeatmap([], { comboColours: [] }));

    expect(palette.source).toBe('default');
    expect(palette.colours).toEqual(DEFAULT_COMBO_COLOURS);
  });

  it('默认四色就是 SkinConfiguration.DefaultComboColours 的那四个', () => {
    // 核过 osu.Game/Skinning/SkinConfiguration.cs。
    // ⚠️ webosu 的兜底四色 [96,159,159] 等**不是**这个 —— 别照抄别人的常量
    expect(DEFAULT_COMBO_COLOURS).toEqual([
      { r: 255, g: 192, b: 0 },
      { r: 0, g: 202, b: 0 },
      { r: 18, g: 124, b: 255 },
      { r: 242, g: 24, b: 57 },
    ]);
  });
});

describe('🔒 索引不对称:offset 只对谱面配色生效', () => {
  /**
   * 这是全文件最有价值的一条。
   *
   * `LegacyBeatmapSkin.cs:89-90` 覆写 `GetComboColour` 并把传入的 `comboIndex`
   * **丢弃**,换成 `combo.ComboIndexWithOffsets`;而未覆写的 `LegacySkin`
   * 用的是调用方传进来的 `ComboIndex`(`IHasComboInformation.cs:70`)。
   *
   * 所以同一个物件,在"谱面给了颜色"和"谱面没给颜色"两种情况下,
   * 取的**索引都不同** —— 不只是颜色表不同。
   */
  it('谱面配色 → 用 comboIndexWithOffsets', () => {
    const beatmap = makeSimBeatmap([], { comboColours: [RED, GREEN, BLUE] });
    const palette = buildComboPalette(beatmap);

    // comboIndex=1 但 withOffsets=2 ⇒ 必须取下标 2 % 3 = 2 的 BLUE
    expect(palette.rgbOf(obj(1, 2))).toEqual(BLUE);
    // 反过来:withOffsets=1 ⇒ GREEN,即使 comboIndex 是 2
    expect(palette.rgbOf(obj(2, 1))).toEqual(GREEN);
  });

  it('皮肤配色 → 用 comboIndex(offset 被忽略)', () => {
    const beatmap = makeSimBeatmap([], { comboColours: [] });
    const palette = buildComboPalette(beatmap, [RED, GREEN, BLUE]);

    // 同一个物件、同样的三色表,这次该按 comboIndex=1 取 GREEN 而不是 BLUE
    expect(palette.rgbOf(obj(1, 2))).toEqual(GREEN);
    expect(palette.rgbOf(obj(2, 1))).toEqual(BLUE);
  });

  it('默认配色 → 同样用 comboIndex', () => {
    const palette = buildComboPalette(makeSimBeatmap([], { comboColours: [] }));

    // comboIndex=1 ⇒ DEFAULT[1] = (0,202,0);withOffsets 应被无视
    expect(palette.rgbOf(obj(1, 3))).toEqual(DEFAULT_COMBO_COLOURS[1]);
  });

  it('两个索引相同时,三条链给出同一个下标 —— 排除"不对称写反了"', () => {
    // 若把 useOffsets 的条件写反,上面三条仍可能各自通过;
    // 这条用"索引相同"的物件把下标对齐,专门堵那个漏
    const same = obj(5, 5);
    const colours = [RED, GREEN, BLUE];

    const fromBeatmap = buildComboPalette(makeSimBeatmap([], { comboColours: colours }));
    const fromSkin = buildComboPalette(makeSimBeatmap([], { comboColours: [] }), colours);

    expect(fromBeatmap.rgbOf(same)).toEqual(fromSkin.rgbOf(same));
    expect(fromBeatmap.rgbOf(same)).toEqual(colours[5 % 3]);
  });
});

describe('combo 索引是 1-based —— 首个 combo 不取第一个颜色', () => {
  it('首个物件(comboIndex=1)取的是第二个颜色', () => {
    // 这条把那个曾经的 off-by-one 钉死:lazer 的首个物件 ComboIndex = 1,
    // 于是 ComboColours[1 % 4] —— **第二个**颜色。
    // 曾经我们从 0 起步,整张图配色错开一格。
    const colours = [RED, GREEN, BLUE];
    const palette = buildComboPalette(makeSimBeatmap([], { comboColours: colours }));

    expect(palette.rgbOf(obj(1))).toEqual(GREEN);
    expect(palette.rgbOf(obj(1))).not.toEqual(RED);
  });
});

describe('滑条轨道色与边框色', () => {
  it('没有 SliderTrackOverride 时用该物件的 combo 色', () => {
    const palette = buildComboPalette(
      makeSimBeatmap([], { comboColours: [RED, GREEN], sliderTrackOverride: null }),
    );
    expect(palette.trackRgbOf(obj(1))).toEqual(GREEN);
  });

  it('有 SliderTrackOverride 时压过 combo 色,且与 combo 无关', () => {
    const palette = buildComboPalette(
      makeSimBeatmap([], { comboColours: [RED, GREEN], sliderTrackOverride: BLUE }),
    );
    // 不同 combo 的物件都该拿到同一个覆盖色
    expect(palette.trackRgbOf(obj(1))).toEqual(BLUE);
    expect(palette.trackRgbOf(obj(2))).toEqual(BLUE);
  });

  it('没有 SliderBorder 时回退白色', () => {
    const palette = buildComboPalette(makeSimBeatmap([], { sliderBorder: null }));
    expect(palette.borderRgb).toEqual(DEFAULT_SLIDER_BORDER);
    expect(palette.borderRgb).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('取模是安全的', () => {
  it('索引远大于颜色数时循环取用', () => {
    const palette = buildComboPalette(makeSimBeatmap([], { comboColours: [RED, GREEN] }));
    expect(palette.rgbOf(obj(100))).toEqual(palette.rgbOf(obj(2)));
  });

  it('索引为负时不越界(上游若出 bug,这里不该抛 undefined)', () => {
    const palette = buildComboPalette(makeSimBeatmap([], { comboColours: [RED, GREEN, BLUE] }));
    expect(palette.rgbOf(obj(-1))).toBeDefined();
    expect(palette.colourOf(obj(-1))).toMatch(/^rgb\(/);
  });
});

describe('CSS 字符串', () => {
  it('cssOf 输出 rgb() 形式', () => {
    expect(cssOf({ r: 18, g: 124, b: 255 })).toBe('rgb(18, 124, 255)');
  });

  it('colourOf 与 rgbOf 指向同一个颜色', () => {
    const palette = buildComboPalette(makeSimBeatmap([], { comboColours: [RED, GREEN, BLUE] }));
    const o = obj(2);
    expect(palette.colourOf(o)).toBe(cssOf(palette.rgbOf(o)));
  });
});
