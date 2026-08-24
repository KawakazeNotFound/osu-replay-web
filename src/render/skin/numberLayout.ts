import type { SkinSprite } from './skinTextures';
import { GLYPH_MAX_DISPLAY, HITCIRCLE_TEXT_SCALE, displaySize } from './spriteGeometry';

/**
 * # legacy 数字字体的排版
 *
 * ## 规则(核 lazer + osu-framework,2026-08-24)
 *
 * ### `Spacing = -overlap`,而且方向是反的
 *
 * ```csharp
 * // osu.Game/Skinning/LegacySpriteText.cs:53-55
 * string fontPrefix = skin.GetFontPrefix(font);
 * base.Font = new FontUsage(fontPrefix, 1, fixedWidth: FixedWidth);
 * Spacing = new Vector2(-skin.GetFontOverlap(font), 0);
 * ```
 *
 * 而 `GetFontOverlap` 的文档写明:
 *
 * > A positive number will bring the number sprites closer together, while a
 * > negative number will split them apart more.
 *
 * 所以 `HitCircleOverlap` 的**默认值 -2 实际让字形分开 2**,不是靠近。
 * 这个符号很容易搞反 —— 名字叫 "overlap",直觉是"越大越挤",而它确实越大越挤,
 * 但**默认值是负的**,于是默认表现是"分开"。
 *
 * ### spacing **不乘** textSize
 *
 * ```csharp
 * // osu-framework/Text/TextBuilder.cs:143-151, 163, 197
 * float kerning = 0;
 * if (!currentNewLine)
 * {
 *     if (Characters.Count > 0)
 *         kerning = glyph.GetKerning(Characters[^1].Glyph);
 *     kerning += spacing.X;
 * }
 * ...
 * currentPos.X += kerning;
 * ...
 * currentPos.X += glyph.XAdvance;
 * ```
 *
 * 注意 `FontUsage(fontPrefix, 1, ...)` 里 size 是 **1**,而 `XAdvance` 是
 * `texture.Width / ScaleAdjust`(即 display 宽)。所以 **overlap 与 display 宽同一坐标系**:
 * @2x 贴图**不要**把 overlap 折半。
 *
 * ### 首字符不加 spacing
 *
 * `currentNewLine` 初值为 `true`(`TextBuilder.cs:102`),所以第一个字形前面没有间距。
 * **推论:一位数的 combo 序号完全不受 `HitCircleOverlap` 影响** ——
 * 用户皮肤那个夸张的 `HitCircleOverlap: 150` 对 combo 1~9 毫无作用。
 *
 * ### 顶对齐,不是基线对齐
 *
 * `LegacySpriteText.cs:47` 设 `UseFullGlyphHeight = false`,而 legacy 的字形
 * `XOffset = YOffset = Baseline = 0`(`LegacySpriteText.cs:104` 构造
 * `new CharacterGlyph(character, 0, 0, texture.Width, 0, null)`)。
 * 于是所有字形 `y = 0`,行高取各字形 display 高的最大值。
 *
 * ### 总宽是"前缀和的最大值",且被钳在 ≥ 0
 *
 * ```csharp
 * // osu-framework/Text/TextBuilder.cs:200
 * Bounds = Vector2.ComponentMax(Bounds, currentPos + new Vector2(0, currentLineHeight));
 * ```
 * `Bounds` 从零起、逐字符取 `ComponentMax`。**这不等于"末字符右边界"** ——
 * 当 spacing 是大负数时,后面的字形会跑到左边,末字符右边界可能比前面的小。
 * 照搬这条语义,不要图省事写成 `x[last] + adv[last]`。
 *
 * ### 无 kerning、非等宽
 *
 * 字形构造时 `containingStore` 传 `null` ⇒ `GetKerning` 恒为 0。
 * `FixedWidth` 未赋值 ⇒ 默认 `false`,每个数字用自己的宽度。
 */

/** 一个字形的排版结果,坐标是**相对文本盒左上角**的 display 单位。 */
export interface GlyphPlacement {
  readonly sprite: SkinSprite;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TextLayout {
  readonly glyphs: readonly GlyphPlacement[];
  /** 文本盒尺寸(display 单位) */
  readonly width: number;
  readonly height: number;
}

export const EMPTY_LAYOUT: TextLayout = { glyphs: [], width: 0, height: 0 };

/**
 * 排一串字形。
 *
 * @param sprites 逐字符的贴图,顺序即显示顺序。含 `null` 表示该字形缺失 ——
 *   **整串作废**(与 lazer 一致:没有 `prefix-0` 就整个数字不画,见
 *   `LegacySkinExtensions.cs:137` 的存在性检查)
 * @param overlap `HitCircleOverlap` / `ScoreOverlap` 之类的原始值
 * @param maxGlyphDisplay 每字形的 display 上限,超出居中裁剪
 */
export function layoutGlyphs(
  sprites: readonly (SkinSprite | null)[],
  overlap: number,
  maxGlyphDisplay: number | null = GLYPH_MAX_DISPLAY,
): TextLayout {
  if (sprites.length === 0 || sprites.some((s) => s === null)) return EMPTY_LAYOUT;

  // ⚠️ 符号:Spacing = -overlap。正的 overlap 让字形靠近
  const spacing = -overlap;

  const glyphs: GlyphPlacement[] = [];
  let cursor = 0;
  let width = 0;
  let height = 0;

  sprites.forEach((sprite, i) => {
    const { w: rawW, h: rawH } = displaySize(sprite!);

    // 每字形独立裁剪 —— 与 spriteQuad 里 maxDisplay 的语义一致
    const over =
      maxGlyphDisplay !== null && (rawW > maxGlyphDisplay || rawH > maxGlyphDisplay);
    const w = over ? Math.min(rawW, maxGlyphDisplay!) : rawW;
    const h = over ? Math.min(rawH, maxGlyphDisplay!) : rawH;

    // 首字符不加 spacing(currentNewLine 初值为 true)
    if (i > 0) cursor += spacing;

    glyphs.push({ sprite: sprite!, x: cursor, y: 0, w, h });

    // Bounds 是逐字符取 ComponentMax,不是"末字符右边界"
    width = Math.max(width, cursor + w);
    height = Math.max(height, h);

    cursor += w;
  });

  // Bounds 从 Vector2.Zero 起 ⇒ 不会为负
  return { glyphs, width: Math.max(0, width), height };
}

/**
 * 圈内数字的排版 —— 就是 {@link layoutGlyphs} 加上 stable 那个 0.8 一刀切。
 *
 * 返回的 `width` / `height` **不含** 0.8(它属于绘制期的缩放),
 * 但字形位置已经算好,调用方乘 `HITCIRCLE_TEXT_SCALE * radiusPx / 64` 即可。
 */
export function layoutHitCircleNumber(
  digitSprites: readonly (SkinSprite | null)[],
  overlap: number,
): TextLayout {
  return layoutGlyphs(digitSprites, overlap, GLYPH_MAX_DISPLAY);
}

/**
 * 把排好的文本盒画到 `(cx, cy)` 为**中心**的位置。
 *
 * @param radiusPx 屏幕像素的物件半径
 * @param textScale 额外缩放。圈内数字传 {@link HITCIRCLE_TEXT_SCALE}
 */
export function drawTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  cx: number,
  cy: number,
  radiusPx: number,
  textScale = HITCIRCLE_TEXT_SCALE,
): void {
  if (layout.glyphs.length === 0) return;

  // display 单位 → 屏幕像素
  const k = (radiusPx / 64) * textScale;

  const originX = cx - (layout.width / 2) * k;
  const originY = cy - (layout.height / 2) * k;

  for (const g of layout.glyphs) {
    const { sprite } = g;
    // 裁剪:w/h 已经是裁过的 display 尺寸,换回源像素
    const sw = g.w * sprite.scale;
    const sh = g.h * sprite.scale;

    ctx.drawImage(
      sprite.image,
      sprite.width / 2 - sw / 2,
      sprite.height / 2 - sh / 2,
      sw,
      sh,
      originX + g.x * k,
      originY + g.y * k,
      g.w * k,
      g.h * k,
    );
  }
}
