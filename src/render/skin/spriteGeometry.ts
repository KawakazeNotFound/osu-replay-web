import { OBJECT_RADIUS } from '../../core/sim/difficulty';
import type { SkinSprite } from './skinTextures';

/**
 * # 贴图的几何:像素尺寸 → 屏幕尺寸,以及居中裁剪
 *
 * ## 换算公式(核过 lazer + osu-framework,2026-08-24)
 *
 * 这条链子绕了三层,每层都可能写错,所以把依据留全:
 *
 * 1. `Sprite` 的尺寸**就是贴图的 display 尺寸**,父容器不会把它拉到 128:
 *    ```csharp
 *    // osu-framework/Graphics/Sprites/Sprite.cs:184-185
 *    if (Size == Vector2.Zero)
 *        Size = new Vector2(texture?.DisplayWidth ?? 0, texture?.DisplayHeight ?? 0);
 *    ```
 *    ⚠️ `LegacyMainCirclePiece.cs:58` 那句 `Size = OsuHitObject.OBJECT_DIMENSIONS`
 *    是**容器自己的盒子**,它不 mask、子精灵也没用 `RelativeSizeAxes` ——
 *    所以**不会**把贴图缩放到 128×128。我原本以为会,那是错的。
 *
 * 2. display 尺寸 = 原始像素 / `ScaleAdjust`:
 *    ```csharp
 *    // osu-framework/Graphics/Textures/Texture.cs:39,44
 *    public float DisplayWidth => Width / ScaleAdjust;
 *    ```
 *    `ScaleAdjust` 在 `LegacySkin.cs:576` 命中 `@2x` 时置 2。
 *
 * 3. 整个 circle piece 再乘物件的 `Scale`:
 *    ```csharp
 *    // DrawableHitCircle.cs:107
 *    ScaleBindable.BindValueChanged(scale => scaleContainer.Scale = new Vector2(scale.NewValue));
 *    // OsuHitObject.cs:94
 *    public double Radius => OBJECT_RADIUS * Scale;   // OBJECT_RADIUS = 64
 *    ```
 *
 * 合起来:**`drawW = (w / ScaleAdjust) × (Radius / 64)`**,以物件中心为几何中心。
 *
 * ### 一条可自检的推论
 *
 * 128×128 的 SD `hitcircle.png` 恰好画成 `2 × Radius`,**且与 CS 无关**
 * (`128/1 × Radius/64 = 2·Radius`)。256×256 的 `@2x` 同样是 `2 × Radius`。
 * 而 256×256 的**非** `@2x` 贴图会被画成 `4 × Radius` —— 不会被缩小。
 * 这条推论有测试钉着,可以当作换算是否写对的判据。
 *
 * ## ⚠️ `LEGACY_CIRCLE_RADIUS`(59)与这里无关
 *
 * ```csharp
 * // OsuLegacySkinTransformer.cs:24-29
 * /// On osu-stable, hitcircles have 5 pixels of transparent padding on each side...
 * /// Their hittable area is 128px, but the actual circle portion is 118px.
 * public const float LEGACY_CIRCLE_RADIUS = OsuHitObject.OBJECT_RADIUS - 5;
 * ```
 * 它唯一的使用点是 `SliderPathRadius`(`:311-313`)—— **只影响滑条体的粗细**,
 * 不参与任何贴图尺寸。看到"118px 才是圈本体"就去把 hitcircle 缩小 59/64 是错的。
 *
 * ## `WithMaximumSize` 是**裁剪**,不是缩放
 *
 * ```csharp
 * // osu.Game/Skinning/LegacySkinExtensions.cs:112-133
 * maxSize *= texture.ScaleAdjust;
 * float newWidth = Math.Min(texture.Width, maxSize.X);
 * var croppedTexture = texture.Crop(new RectangleF(
 *     texture.Width / 2f - newWidth / 2f, ..., newWidth, newHeight));
 * ```
 * 超大贴图**居中切边**,不会被缩小。所以 canvas2d 要用 9 参数版 `drawImage`
 * 指定 srcRect,而**不是**把 dst 尺寸缩下来"适配"。
 */

/**
 * 圈类贴图的 display 尺寸上限。
 *
 * 核 `LegacyMainCirclePiece.cs:84`:`Vector2 maxSize = OsuHitObject.OBJECT_DIMENSIONS * 2;`
 * 而 `OBJECT_DIMENSIONS = 128` ⇒ 256。
 */
export const CIRCLE_MAX_DISPLAY = OBJECT_RADIUS * 2 * 2;

/**
 * 圈内数字的每字形上限。
 *
 * 核 `OsuLegacySkinTransformer.cs:273`:`MaxSizePerGlyph = OBJECT_DIMENSIONS * 2 / hitcircle_text_scale`
 * —— 注意它**除以了** 0.8,因为整体又乘回 0.8。
 */
export const GLYPH_MAX_DISPLAY = CIRCLE_MAX_DISPLAY / 0.8;

/**
 * stable 对圈内数字的一刀切缩放。
 *
 * 核 `OsuLegacySkinTransformer.cs:268-272`:
 * ```csharp
 * const float hitcircle_text_scale = 0.8f;
 * // stable applies a blanket 0.8x scale to hitcircle fonts
 * Scale = new Vector2(hitcircle_text_scale),
 * ```
 */
export const HITCIRCLE_TEXT_SCALE = 0.8;

/** 一次 `drawImage` 需要的全部参数(9 参数版)。 */
export interface SpriteQuad {
  /** 源矩形 —— 居中裁剪的结果。未超限时就是整张图 */
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  /** 目标矩形(屏幕像素),已按中心点摆好 */
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
}

/**
 * 贴图的 display 尺寸(= 原始像素 / `ScaleAdjust`)。
 *
 * 这是 osu 内部那套"与 HD/SD 无关"的坐标系,`HitCircleOverlap` 之类的
 * 排版常数都在这个坐标系里。
 */
export function displaySize(sprite: SkinSprite): { readonly w: number; readonly h: number } {
  return { w: sprite.width / sprite.scale, h: sprite.height / sprite.scale };
}

/**
 * 算出把 `sprite` 画在 `(cx, cy)`(屏幕像素)时的 `drawImage` 参数。
 *
 * @param radiusPx **屏幕像素**的物件半径(即 `radiusFromCS(cs) * playfieldScale`)
 * @param maxDisplay display 尺寸上限,超出则**居中裁剪**。传 `null` 不限
 * @param extraScale 额外倍数(命中动画的 grow、数字的 0.8 等)
 */
export function spriteQuad(
  sprite: SkinSprite,
  cx: number,
  cy: number,
  radiusPx: number,
  maxDisplay: number | null = CIRCLE_MAX_DISPLAY,
  extraScale = 1,
): SpriteQuad {
  const sa = sprite.scale;
  let { w: dispW, h: dispH } = displaySize(sprite);

  let sx = 0;
  let sy = 0;
  let sw = sprite.width;
  let sh = sprite.height;

  // 裁剪(不是缩放)。源码先判断"两个维度都不超"才直接返回,否则逐轴取 min ——
  // 注释说明这是为了"避免把怪长宽比的贴图意外拉大"
  if (maxDisplay !== null && (dispW > maxDisplay || dispH > maxDisplay)) {
    const limit = maxDisplay * sa;
    sw = Math.min(sprite.width, limit);
    sh = Math.min(sprite.height, limit);
    sx = sprite.width / 2 - sw / 2;
    sy = sprite.height / 2 - sh / 2;
    dispW = sw / sa;
    dispH = sh / sa;
  }

  // 核心换算:display 尺寸 × (Radius / 64)
  const k = (radiusPx / OBJECT_RADIUS) * extraScale;
  const dw = dispW * k;
  const dh = dispH * k;

  return { sx, sy, sw, sh, dx: cx - dw / 2, dy: cy - dh / 2, dw, dh };
}

/** 按 {@link SpriteQuad} 画一张贴图。 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: SkinSprite,
  quad: SpriteQuad,
): void {
  ctx.drawImage(
    sprite.image,
    quad.sx, quad.sy, quad.sw, quad.sh,
    quad.dx, quad.dy, quad.dw, quad.dh,
  );
}
