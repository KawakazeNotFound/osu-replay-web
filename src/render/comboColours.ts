import type { Rgb, SimBeatmap, SimHitObject } from '../core/sim/types';

/**
 * # combo 配色的优先级链
 *
 * ## 为什么这值得一个独立文件
 *
 * 因为**取颜色时用哪个索引,取决于颜色来自哪一层** —— 这个不对称不是猜的,
 * 是核 lazer 源码核出来的,而且从注释里读不出来(注释和默认实现互相矛盾)。
 *
 * 调用链(2026-08-24 核):
 *
 * ```
 * IHasComboInformation.cs:70   GetComboColour(skin) => GetSkinComboColour(this, skin, ComboIndex)
 *                                                                                    ^^^^^^^^^^ 传的是不含 offset 的
 * LegacySkin.cs                GetComboColour(src, colourIndex, combo)
 *                                => src.ComboColours[colourIndex % src.ComboColours.Count]
 * LegacyBeatmapSkin.cs:89-90   protected override GetComboColour(src, comboIndex, combo)
 *                                => base.GetComboColour(src, combo.ComboIndexWithOffsets, combo)
 *                                                             ^^^^^^^^^^^^^^^^^^^^^^^^^^ 参数被丢弃,换成含 offset 的
 * ```
 *
 * 于是:
 *
 * | 颜色来源 | 索引 |
 * |---|---|
 * | 谱面 `[Colours]` | `comboIndexWithOffsets`(累加 combo-skip 位) |
 * | 皮肤 `skin.ini [Colours]` | `comboIndex` |
 * | osu 默认四色 | `comboIndex` |
 *
 * 也就是说 **combo-skip 位只对谱面自带的配色生效**。谱面没给颜色时,
 * 谱师写的跳色意图会被完全忽略 —— 这听起来像 bug,但它是 lazer 的实际行为。
 *
 * ## 链条怎么接
 *
 * `LegacyBeatmapSkin` 构造函数里有一行 `AllowDefaultComboColoursFallback = false`,
 * 注释写明用意:*"Disallow default colours fallback on beatmap skins to allow
 * using parent skin combo colours."* —— 谱面没有 `[Colours]` 时它返回 null
 * 而**不是**兜底成默认色,这样查找才会继续落到用户皮肤那一层。
 *
 * 所以顺序是:谱面 → 用户皮肤 → 默认色。
 *
 * ## 还没做的
 *
 * - 皮肤那一层(`skinColours` 参数)现在恒为空 —— 皮肤系统是 M4。
 * - lazer 设置里的"Beatmap colours"开关(`SkinProvidingContainer.AllowColourLookup`)
 *   可以整层禁用谱面配色。回放文件里不记这个设置,所以只能当成播放器选项,
 *   将来要做就加个参数。
 */

/**
 * osu! 的默认 combo 四色。
 *
 * 核 `osu.Game/Skinning/SkinConfiguration.cs`(2026-08-24):
 *
 * ```csharp
 * public static List<Color4> DefaultComboColours { get; } = new List<Color4>
 * {
 *     new Color4(255, 192, 0, 255),
 *     new Color4(0, 202, 0, 255),
 *     new Color4(18, 124, 255, 255),
 *     new Color4(242, 24, 57, 255),
 * };
 * ```
 *
 * ⚠️ webosu(`js/osu.js:220-227`)兜底用的是另外四色
 * `[96,159,159] [192,192,192] [128,255,255] [139,191,222]` —— **那不是 osu 的默认色**,
 * 是它自己编的。参考别人的实现时这种"看起来很权威的常量"最容易照抄出错。
 *
 * ⚠️ lazer 自己的新皮肤(Argon)另有一套配色。我们做的是 stable 观感,用这套 legacy 默认。
 */
export const DEFAULT_COMBO_COLOURS: readonly Rgb[] = [
  { r: 255, g: 192, b: 0 },
  { r: 0, g: 202, b: 0 },
  { r: 18, g: 124, b: 255 },
  { r: 242, g: 24, b: 57 },
];

/** 谱面与皮肤都没给 `SliderBorder` 时的颜色。核 `LegacySkin`:回退到白色。 */
export const DEFAULT_SLIDER_BORDER: Rgb = { r: 255, g: 255, b: 255 };

/** 颜色链最终选中的那一层。仅供调试与测试断言用。 */
export type ComboColourSource = 'beatmap' | 'skin' | 'default';

export interface ComboPalette {
  /** 这次用的是哪一层颜色 */
  readonly source: ComboColourSource;
  /** 该层的颜色表,按取用顺序 */
  readonly colours: readonly Rgb[];
  /** 取某物件的 combo 颜色 —— CSS 字符串,预先算好,不每帧建串 */
  colourOf(object: SimHitObject): string;
  /** 同上但返回 Rgb,供需要算亮度 / 做渐变的调用方(如滑条体 LUT) */
  rgbOf(object: SimHitObject): Rgb;
  /** 滑条轨道色。`SliderTrackOverride` 优先,否则用该物件的 combo 色 */
  trackRgbOf(object: SimHitObject): Rgb;
  /** 滑条边框色。`SliderBorder` 优先,否则白色 */
  readonly borderRgb: Rgb;
}

export function cssOf(colour: Rgb): string {
  return `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
}

/**
 * 建一份 combo 配色表。谱面加载后建一次即可,不要每帧建。
 *
 * @param skinColours 用户皮肤 `skin.ini [Colours]` 的配色。M4 之前恒为空。
 */
export function buildComboPalette(
  beatmap: SimBeatmap,
  skinColours: readonly Rgb[] = [],
): ComboPalette {
  // 优先级链:谱面 → 皮肤 → 默认。见文件头注释里的源码依据。
  const [source, colours]: [ComboColourSource, readonly Rgb[]] =
    beatmap.comboColours.length > 0 ? ['beatmap', beatmap.comboColours]
    : skinColours.length > 0 ? ['skin', skinColours]
    : ['default', DEFAULT_COMBO_COLOURS];

  // ⚠️ 索引的选择跟着 source 走,不是固定的 —— 这是本文件存在的理由
  const useOffsets = source === 'beatmap';

  const css = colours.map(cssOf);

  const indexOf = (object: SimHitObject): number => {
    const raw = useOffsets ? object.comboIndexWithOffsets : object.comboIndex;
    // 两个 index 都是 1-based 且单调不减,正常不会为负。取模前兜一下负数,
    // 免得上游哪天出 bug 时这里抛出一个更难查的 undefined。
    const n = colours.length;
    return ((raw % n) + n) % n;
  };

  const track = beatmap.sliderTrackOverride;

  return {
    source,
    colours,
    colourOf: (object) => css[indexOf(object)]!,
    rgbOf: (object) => colours[indexOf(object)]!,
    trackRgbOf: (object) => track ?? colours[indexOf(object)]!,
    borderRgb: beatmap.sliderBorder ?? DEFAULT_SLIDER_BORDER,
  };
}
