import { ReplayKey, cursorAt, normalizeKeys } from '../core/replay/frames';
import { preemptFromAR, radiusFromCS } from '../core/sim/difficulty';
import { pathOffsetAt, pathRangeBounds } from '../core/sim/sliderPath';
import { sliderBallAt } from '../core/sim/sliderTracking';
import {
  type PlaybackState,
  type ReplayTimeline,
  type SimBeatmap,
  type SimHitObject,
} from '../core/sim/types';
import { lastIndexAtOrBefore } from '../core/util/search';
import { approachAlphaAt, approachScaleAt } from './approachCircle';
import {
  STABLE_MAGIC_SCALE_FACTOR,
  TRAIL_FADE_MS,
  cursorExpandScaleAt,
  cursorRotationAt,
  disjointTrailTimes,
  trailAlphaAt,
  type TrailMode,
} from './cursor';
import { buildComboPalette, type ComboPalette } from './comboColours';
import { userSkinLayer } from './skin/defaultSkin';
import { layoutHitCircleNumber, drawTextLayout } from './skin/numberLayout';
import { CIRCLE_MAX_DISPLAY, drawSprite, spriteQuad } from './skin/spriteGeometry';
import { circleComponentName, findProvider, type SkinLayer } from './skin/skinStack';
import { resolveTexture, type SkinPackage } from './skin/skinFiles';
import {
  NO_SPRITES,
  OSU_STD_COMPONENTS,
  browserDecoder,
  fontComponents,
  loadSkinSprites,
  type ImageDecoder,
  type SkinSprite,
  type SkinSprites,
} from './skin/skinTextures';
import {
  NO_TINTED,
  TINTED_COMPONENTS,
  browserCanvasFactory,
  buildTintedSprites,
  type CanvasFactory,
  type TintedSprites,
} from './skin/tint';
import { snakeRangeAt } from './sliderSnaking';

/** {@link DebugRenderer.setSkin} 的注入点 —— 让测试不必有真 canvas / createImageBitmap。 */
export interface SkinLoadOptions {
  readonly decode?: ImageDecoder;
  readonly makeCanvas?: CanvasFactory;
}

/**
 * osu! 判定区尺寸(固定常量)。
 *
 * ⚠️ 物件坐标一定落在这个空间内,但**光标坐标不一定** —— 实测 stable 能到
 * `x∈[-20, 527]` / `y∈[-27, 397]`,lazer 更夸张。玩家把鼠标移到判定区外是
 * 正常操作,那是真实输入而非脏数据。所以**不要 clamp 光标坐标**:
 * 让它自然画到判定区边框外(超出画布则由 canvas 裁掉),
 * 这与 osu 里鼠标移出判定区的表现一致。见 TECH-NOTES B5。
 */
const PLAYFIELD_WIDTH = 512;
const PLAYFIELD_HEIGHT = 384;

/**
 * 判定区占可用区域的比例。
 *
 * ## 这个数不能瞎写
 *
 * 核 `osu.Game.Rulesets.Osu/UI/OsuPlayfieldAdjustmentContainer.cs`(2026-08-24):
 *
 * ```csharp
 * private const float playfield_size_adjust = 0.8f;
 * // Calculated from osu!stable as 512 (default gamefield size) / 640 (default window size)
 * Size = new Vector2(playfield_size_adjust);
 * InternalChild = new Container { FillMode = FillMode.Fit, FillAspectRatio = 4f / 3, ... };
 * ```
 *
 * 即:**先把可用区域两个维度各乘 0.8,再在那个盒子里按 4:3 letterbox**。
 * 等价于 `min(W/512, H/384) * 0.8`。
 *
 * ⚠️ 之前这里写的是 `0.9`(我随手定的),导致判定区与泡泡都**大了 12.5%** ——
 * 用户实测一眼看出来"泡泡大小不对"。
 *
 * 另一处已核实的事:**默认没有垂直偏移**。`ScalingContainer` 里
 * `Position = new Vector2(0, (PlayfieldShift ? 8f : 0f) * Scale.X)`,
 * 而 `PlayfieldShift` 只有 `AlignWithStoryboard` 才置真(为了对齐老故事板)。
 * 所以正常回放里判定区就是**居中**的 —— 我们的居中是对的。
 */
const PLAYFIELD_SIZE_ADJUST = 0.8;

/** 光标拖尾显示的时长(ms,谱面时间) */
const TRAIL_MS = 400;

/**
 * 命中后的淡出时长(ms,谱面时间)。
 *
 * osu! 里圈被点中后会**立刻**开始命中动画(扩散 + 淡出),而不是等到判定窗口结束。
 * 之前的实现无条件画出 `activeObjects` 里的每一个物件、完全不看判定结果,
 * 于是圈被点掉之后还会继续画到视觉窗口末尾 —— 表现就是"泡泡点完了不消失"。
 */
export const HIT_FADE_MS = 240;

/**
 * 命中动画的最终缩放。
 *
 * 核 `osu.Game.Rulesets.Osu/Skinning/Legacy/LegacyMainCirclePiece.cs:166-177`:
 *
 * ```csharp
 * const double legacy_fade_duration = 240;
 * CircleSprite.FadeOut(legacy_fade_duration);                        // 无 easing ⇒ 线性
 * CircleSprite.ScaleTo(1.4f, legacy_fade_duration, Easing.Out);      // ⚠️ 不是线性
 * ```
 *
 * 动画起点是 `BeginAbsoluteSequence(drawableObject.HitStateUpdateTime)`,
 * 即**实际命中时刻** —— 所以我们用 `state.time - hitTime` 算进度是对的。
 */
const HIT_SCALE = 1.4;

/**
 * `Easing.Out` —— 核 `ppy/osu-framework` 的 `DefaultEasingFunction.cs:50-52`:
 *
 * ```csharp
 * case Easing.Out:
 * case Easing.OutQuad:
 *     return time * (2 - time);
 * ```
 *
 * 即 `2t - t²`,先快后慢。之前这里是线性的 `0.4 * progress`,与 osu 差别肉眼可见。
 */
function outQuad(t: number): number {
  return t * (2 - t);
}

/** 命中动画不生效时的取值。 */
const NO_HIT_ANIMATION = { alpha: 1, grow: 1 } as const;

/**
 * 头部(普通圈 / 滑条头)的命中动画。返回 `null` = 已淡完,不该再画。
 *
 * ## 滑条头与普通圈完全一样
 *
 * 核过 `DrawableSliderHead.cs`(2026-08-24):它**没有**覆写
 * `UpdateHitStateTransforms`,所以直接继承 `DrawableHitCircle` 的动画。
 * 用户实测报的"滑条头点了之后愣在原地"就是因为我们之前把这个动画
 * 用 `object.kind === 'circle'` 挡掉了。
 *
 * ## 转盘刻意不做
 *
 * 转盘的命中表现由 `DrawableSpinner` 自己实现,是另一套(不是扩散淡出)。
 * **没核过,所以不猜** —— 转盘维持原样(不做命中动画)。
 */
function headAnimationAt(
  object: SimHitObject,
  hitTime: number | null,
  time: number,
): { readonly alpha: number; readonly grow: number } | null {
  if (object.kind === 'spinner') return NO_HIT_ANIMATION;
  // hitTime === null:还没判定,或者头 miss 了。miss 的淡出是另一条路径
  // (`ArmedState.Miss`),源码里不在 LegacyMainCirclePiece 处理,我们暂时也不做
  if (hitTime === null) return NO_HIT_ANIMATION;

  const since = time - hitTime;
  if (since >= HIT_FADE_MS) return null;
  if (since < 0) return NO_HIT_ANIMATION;

  const t = since / HIT_FADE_MS;
  return {
    alpha: 1 - t, // FadeOut(240):线性
    grow: 1 + (HIT_SCALE - 1) * outQuad(t), // ScaleTo(1.4, 240, Easing.Out)
  };
}

/**
 * 滑条体横截面烘成多少级不透明色。
 *
 * 这是"用绘制顺序模拟深度测试"的采样数:每一级一次 `stroke()`。
 * 32 级在 CS4(屏上半径约 60px)时每级约 2px 宽,肉眼看不出台阶;
 * 实际会按屏上半径下调(见 `drawSliderBody`),小滑条不浪费描边。
 */
const BODY_LEVELS = 32;

/**
 * 滑条体的横截面配置。三个数都取自 webosu `js/SliderMesh.js` 的实测值。
 *
 * - `BORDER_WIDTH = 0.128`:边框占半径的比例(`borderwidth`)
 * - `EDGE_OPACITY = 0.8`:轨道色在**内边缘**(紧贴边框处)的不透明度
 * - `CENTER_OPACITY = 0.3`:轨道色在**中心线**的不透明度
 *
 * 注意 RGB 是恒定的,只有 alpha 从 0.8 渐到 0.3 —— 也就是说
 * **中心比边缘更透**,这正是"管道"观感的来源(中心能透出背景)。
 * 我曾经把它写反(中心画成近乎不透明的深色),观感差得很明显。
 */
const BORDER_WIDTH = 0.128;
const EDGE_OPACITY = 0.8;
const CENTER_OPACITY = 0.3;

/**
 * 判定区背景色。滑条体的 alpha ramp 要合成到它上面。
 *
 * ⚠️ 这个耦合是**刻意**的,也是本方案唯一的近似:我们用"不透明同心描边"换取
 * 自相交不叠加,代价是没法真的半透明 —— 于是把 alpha 预先合成到已知的背景色上。
 * 判定区背景是纯色时逐像素精确;将来渲染谱面背景图 / 故事板后就会失真
 * (滑条体中心该透出图片,却透出这个纯色)。那时就该上 M2 的 WebGL 方案。
 */
const PLAYFIELD_BG = { r: 0x0f, g: 0x0f, b: 0x14 } as const;

/** 同一个颜色的 CSS 形式 —— 清屏用。两处共用一个来源,免得改了一处漂移。 */
const PLAYFIELD_BG_CSS = `rgb(${PLAYFIELD_BG.r}, ${PLAYFIELD_BG.g}, ${PLAYFIELD_BG.b})`;

/**
 * 横截面第 t 级的**不透明**颜色。`t`:0 = 轮廓边,1 = 中心线。
 *
 * 外侧 {@link BORDER_WIDTH} 一段是边框色,其余是轨道色且 alpha 由
 * {@link EDGE_OPACITY} 线性降到 {@link CENTER_OPACITY};最后把 alpha
 * 合成到 {@link PLAYFIELD_BG} 上得到不透明值。
 */
function bodyLevelColour(
  t: number,
  track: { r: number; g: number; b: number },
  border: { r: number; g: number; b: number },
): string {
  const inBorder = t < BORDER_WIDTH;

  // 边框整体偏实;轨道色按 t 在两个不透明度之间插值
  const alpha = inBorder
    ? EDGE_OPACITY
    : EDGE_OPACITY + (CENTER_OPACITY - EDGE_OPACITY) * ((t - BORDER_WIDTH) / (1 - BORDER_WIDTH));

  const src = inBorder ? border : track;

  // 合成到背景:out = src * a + bg * (1 - a)
  const mix = (s: number, b: number) => Math.round(s * alpha + b * (1 - alpha));

  return `rgb(${mix(src.r, PLAYFIELD_BG.r)}, ${mix(src.g, PLAYFIELD_BG.g)}, ${mix(src.b, PLAYFIELD_BG.b)})`;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * canvas2d 调试渲染器 —— **M0 专用,不追求观感**。
 *
 * 存在的唯一目的:验证「时钟 → stateAt → 无状态渲染」这条链路真的能做到
 * 任意 seek 都正确。M1 起会被 PixiJS/WebGL 渲染器取代。
 *
 * 关键性质:本类**不持有任何跨帧的游戏状态**。每次 draw 只依赖传入的 state。
 * 拖尾看起来"有历史",但那是从 timeline 里按 t 查出来的,不是累积的。
 * 这个区别很重要 —— 前者能正确响应倒退,后者不能。
 */
export class DebugRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  /** 判定区 → 画布的缩放与偏移 */
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  /**
   * combo 配色表的记忆化。
   *
   * ## 这为什么不算"跨帧可变状态"
   *
   * 本类的核心约束是不得持有跨帧的**游戏**状态(见类注释)。这里是一份
   * **由不可变输入完全决定的记忆化缓存**:键是 `SimBeatmap` 的对象标识,
   * 而 timeline 一旦编译出来就不可变。同一个键必然给出同一个值,
   * 所以它无法让"第 N 帧的输出"依赖"第 N-1 帧画了什么" —— 这正是那条约束
   * 想禁止的东西。判据是**幂等性**,不是"有没有字段"。
   *
   * 反例(不可以):在这里存"上次命中的时刻"来驱动动画。那样倒退就错了。
   */
  private palette: ComboPalette | null = null;
  private paletteFor: SimBeatmap | null = null;

  /**
   * 已加载的皮肤与派生物。
   *
   * 与 {@link palette} 同一条理由:装好之后**不可变**,所以持有它们不违反
   * "渲染层不得持有跨帧状态"—— 判据是幂等性,不是"有没有字段"。
   */
  private skin: SkinPackage | null = null;
  private layers: readonly SkinLayer[] = [];
  private sprites: SkinSprites = NO_SPRITES;
  private tinted: TintedSprites = NO_TINTED;
  private defaultLayer: SkinLayer | null = null;
  private makeCanvas: CanvasFactory = browserCanvasFactory;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 2d context');
    this.ctx = ctx;
  }

  /**
   * 换皮肤。传 `null` 卸载。
   *
   * ## 为什么是 async
   *
   * 贴图必须**在开始渲染之前**全部装好 —— 见 `skin/skinTextures.ts` 头部那段:
   * 若"画的时候没解码就先画线框",同一个时刻会先后给出两种结果,
   * 「正放到达 == 直接 seek 到达」这条核心不变式就破了。
   *
   * 所以这里 await 装完再一次性换上。装载期间维持旧皮肤(或线框),不会闪。
   */
  async setSkin(skin: SkinPackage | null, options: SkinLoadOptions = {}): Promise<void> {
    const decode = options.decode ?? browserDecoder;
    const makeCanvas = options.makeCanvas ?? browserCanvasFactory;

    if (skin === null) {
      this.skin = null;
      this.layers = [];
      this.sprites = NO_SPRITES;
      this.tinted = NO_TINTED;
      this.invalidatePalette();
      return;
    }

    // 皮肤栈:用户皮肤 → 默认皮肤(逐组件回退,见 skin/skinStack.ts)
    const layers: SkinLayer[] = [userSkinLayer(skin.ini, skin.files)];
    if (this.defaultLayer !== null) layers.push(this.defaultLayer);

    // 数字字体的前缀是运行期才知道的(来自 skin.ini),所以按前缀展开
    const names = [
      ...OSU_STD_COMPONENTS,
      ...fontComponents(skin.ini.hitCirclePrefix),
    ];

    const sprites = await loadSkinSprites(layers, names, decode);

    this.skin = skin;
    this.layers = layers;
    this.sprites = sprites;
    this.makeCanvas = makeCanvas;
    this.invalidatePalette();
  }

  /** 装上默认皮肤兜底层。在 {@link setSkin} 之前调用。 */
  setDefaultSkinLayer(layer: SkinLayer | null): void {
    this.defaultLayer = layer;
    this.invalidatePalette();
  }

  /**
   * 让配色表与染色表失效。
   *
   * 记忆化的键是 `beatmap`,但值还依赖皮肤 —— 所以换皮肤必须显式作废,
   * 否则会一直用旧皮肤的配色。
   */
  private invalidatePalette(): void {
    this.palette = null;
    this.paletteFor = null;
    this.tinted = NO_TINTED;
  }

  /**
   * 取(或按需重建)该谱面的 combo 配色表 + 染色表。
   *
   * ## 为什么两者一起建
   *
   * 染色用的颜色**必须**是走完优先级链之后的最终配色(谱面 → 皮肤 → 默认),
   * 而那条链依赖 `beatmap`。所以染色表和配色表的有效期完全一致,
   * 分开维护只会多一个失效点。见 {@link palette}。
   */
  private paletteOf(beatmap: SimBeatmap): ComboPalette {
    if (this.paletteFor !== beatmap || this.palette === null) {
      const palette = buildComboPalette(beatmap, this.skin?.ini.comboColours ?? []);

      this.palette = palette;
      this.paletteFor = beatmap;
      this.tinted =
        this.sprites === NO_SPRITES
          ? NO_TINTED
          : buildTintedSprites(this.sprites, TINTED_COMPONENTS, palette.colours, this.makeCanvas);
    }
    return this.palette;
  }

  /** 按容器尺寸与 devicePixelRatio 重算画布分辨率。窗口 resize 时调用。 */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));

    // 等比缩放并居中(letterbox)。0.8 是 osu 的 playfield_size_adjust,
    // 见 PLAYFIELD_SIZE_ADJUST 的注释 —— 这个数是核过源码的,别改成"看起来舒服"的值
    const fit = Math.min(
      this.canvas.width / PLAYFIELD_WIDTH,
      this.canvas.height / PLAYFIELD_HEIGHT,
    );
    this.scale = fit * PLAYFIELD_SIZE_ADJUST;
    this.offsetX = (this.canvas.width - PLAYFIELD_WIDTH * this.scale) / 2;
    this.offsetY = (this.canvas.height - PLAYFIELD_HEIGHT * this.scale) / 2;
  }

  draw(timeline: ReplayTimeline, state: PlaybackState): void {
    const { ctx } = this;

    // canvas context 本身就是一份跨帧可变状态 —— 这一条同样受"渲染层不得持有
    // 跨帧状态"约束。曾经踩过:`drawTrail` 设了 lineCap='round' 却不复位,而它在
    // 时间轴起点会提前 return(那时还没有任何回放帧),于是首帧的光标用默认
    // 'butt' 描边、后续帧用上一帧泄漏进来的 'round'。`arc(0, 2π)` 是开放路径,
    // 线帽会影响接缝那一像素 —— 表现为"同一时刻首次渲染与之后渲染差一个像素"。
    // 所以每帧开头把用到的状态全部归零,不依赖上一帧留下什么。
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.globalAlpha = 1;

    ctx.fillStyle = PLAYFIELD_BG_CSS;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.drawPlayfieldBorder();
    this.drawHitObjects(timeline, state);
    // approach circle 统一画在所有物件之上 —— 见 drawApproachCircles() 的注释
    this.drawApproachCircles(timeline, state);

    this.drawTrail(timeline, state);
    this.drawCursor(timeline, state);
  }

  private toScreenX(x: number): number {
    return this.offsetX + x * this.scale;
  }

  private toScreenY(y: number): number {
    return this.offsetY + y * this.scale;
  }

  private drawPlayfieldBorder(): void {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = Math.max(1, this.scale);
    ctx.strokeRect(
      this.offsetX,
      this.offsetY,
      PLAYFIELD_WIDTH * this.scale,
      PLAYFIELD_HEIGHT * this.scale,
    );
  }

  /**
   * 物件绘制:滑条体 + 圈 + approach circle + 命中动画。
   *
   * ## 命中动画只作用于"头",不作用于滑条体
   *
   * 这是用户实测报出来的:滑条头被点中后应该像普通圈一样扩散淡出,而不是
   * "愣在原地"。核过源码:`DrawableSliderHead` **没有**覆写
   * `UpdateHitStateTransforms`,所以它继承 `DrawableHitCircle` 的动画 ——
   * 滑条头与普通圈的命中表现**完全一样**。
   *
   * 但滑条的**体与球不受影响**:体的生死由 snaking 决定(见 `sliderSnaking.ts`),
   * 球一直画到 `endTime`。所以两者不能共用一个 alpha —— 之前就是共用的,
   * 于是要么头不淡出、要么淡出时把整条体一起带走。
   *
   * ⚠️ 这里仍然**不持有跨帧状态** —— 动画进度是从 `state.time - hitTime` 算出来的,
   * 所以倒退与任意 seek 都正确。若改成"命中时启动一个动画计时器"就会破坏这一点。
   */
  private drawHitObjects(timeline: ReplayTimeline, state: PlaybackState): void {
    const { ctx } = this;
    const radius = radiusFromCS(timeline.beatmap.difficulty.circleSize) * this.scale;
    const palette = this.paletteOf(timeline.beatmap);

    // ⚠️ 之前这里硬编码 800ms 当 preempt —— 必错:AR 越高 preempt 越短
    // (AR10 只有 450ms),硬编码会让高 AR 的图 approach circle 收缩得过慢。
    // 真实值:TimePreempt = trunc(difficultyRange(AR, 1800, 1200, 450))
    const preempt = preemptFromAR(timeline.beatmap.difficulty.approachRate);
    // TimeFadeIn = 400 * min(1, TimePreempt / 450)
    const fadeIn = 400 * Math.min(1, preempt / 450);

    // 倒序绘制:osu! 的图层约定是越早的物件在越上层
    for (let i = state.activeObjects.length - 1; i >= 0; i--) {
      const active = state.activeObjects[i]!;
      const { object, result } = active;

      const untilHit = object.startTime - state.time;

      // 淡入:物件在 startTime - preempt 出现,over TimeFadeIn 淡到不透明。
      // 少了这个物件会"啪"地凭空出现
      const fadeInAlpha = untilHit > 0 ? clamp01((preempt - untilHit) / fadeIn) : 1;

      // 滑条上,这是**头**的命中时刻 —— judgement.ts 把 result 覆写成聚合结果时
      // 刻意保留了 head.hitTime。所以"头有没有被点中"就等价于 hitTime !== null
      const hitTime = result?.hitTime ?? null;
      const head = headAnimationAt(object, hitTime, state.time);

      // 头淡完之后:circle / spinner 整条不再画;**滑条的体与球还要继续**
      if (head === null && object.kind !== 'slider') continue;

      // 用**堆叠后**的坐标 —— osu 会把位置相近、时间相邻的物件依次错开,
      // 而 lazer 的命中检测也是基于 StackedPosition。见 sim/stacking.ts
      const cx = this.toScreenX(object.stackedX);
      const cy = this.toScreenY(object.stackedY);

      // ⚠️ 判"头"有没有 miss,不能看 result.result —— 那是**聚合**结果。
      // 滑条可以"头命中但整体判 miss"(比如刻度全丢),那时头不该画成红的。
      // hitTime 才是头自己的信号(judgement.ts:325 `result === Miss ? null : time`)
      const headMissed = result !== null && hitTime === null;

      ctx.save();

      // 滑条体:画在圈底下,用**淡入** alpha —— 不跟着头一起淡出
      if (object.kind === 'slider' && object.path.count > 0) {
        ctx.globalAlpha = fadeInAlpha;
        this.drawSliderBody(object, radius, state.time, preempt, palette);
      }

      if (head !== null) {
        ctx.globalAlpha = fadeInAlpha * head.alpha;

        // 贴图路径优先;皮肤没提供就退回线框。**逐组件降级**,不是"有皮肤就全用贴图"
        // —— 用户的 test.osk 实测缺 approachcircle 与 reversearrow,而别的皮肤
        // 可能缺得更多。核过 lazer:回退是逐组件的(SkinProvidingContainer.GetTexture)
        const circleName = this.drawCirclePiece(object, cx, cy, radius, head.grow, palette);

        if (circleName === null) {
          ctx.strokeStyle =
            headMissed ? '#ff4d6d'
            : object.kind === 'spinner' ? '#7f7fff'
            : palette.colourOf(object);
          ctx.lineWidth = Math.max(1.5, 2 * this.scale);
          ctx.beginPath();
          ctx.arc(cx, cy, radius * head.grow, 0, Math.PI * 2);
          ctx.stroke();
        }

        // combo 内序号。
        //
        // 条件是"还没被判定"(result === null)而不是 hitTime === null ——
        // 后者在 **miss** 时也成立,会让漏掉的圈一直顶着数字不放。
        //
        // 近似:真实行为是新版 legacy 皮肤把数字单独淡出 240/4 = 60ms 且不缩放
        // (`LegacyMainCirclePiece.cs:191`),我们直接让它消失。60ms 内几乎看不出来。
        if (object.kind !== 'spinner' && result === null) {
          this.drawComboNumber(object.indexInCombo, cx, cy, radius);
        }

        // ⚠️ `HitCircleOverlayAboveNumber` 默认 **true**,那时 overlay 要画在数字**之上**
        // —— 所以它在这里,而不是在 drawCirclePiece 里。
        // 我第一版把它只放在 drawCirclePiece 的 `!overlayAboveNumber()` 分支里,
        // 结果**默认情况下 overlay 根本不画**;测试"overlay 也画出来"抓到了这个
        if (circleName !== null && this.overlayAboveNumber()) {
          this.drawCircleOverlay(circleName, cx, cy, radius, head.grow);
        }

        // approach circle 刻意**不在这里画** —— osu 把它们全部 proxy 到
        // 一个独立的顶层容器(`OsuPlayfield.cs:74` 的 approachCircles),
        // 所以任何 approach circle 都在**所有**物件之上。见 drawApproachCircles()
      }

      ctx.restore();
    }
  }

  /**
   * 圈体(hitcircle 或 sliderstartcircle)。
   *
   * 返回用到的**组件名**,供调用方接着查 `${name}overlay`;
   * 返回 `null` = 皮肤没提供贴图,调用方该退回线框。
   *
   * ## 组件名的决策看单层,取图看全栈
   *
   * `circleComponentName` 复现了 `LegacyMainCirclePiece.load()` 那段 ——
   * 滑条头想用 `sliderstartcircle`,但只有在**提供 `hitcircle` 的那一层**
   * 也有它时才用。见 `skin/skinStack.ts`。
   *
   * ## overlay 只查 `${name}overlay`,查不到就不画
   *
   * 源码注释写明:`sliderendcircle.png` 存在但 `sliderendcircleoverlay.png` 不存在时,
   * 期望行为是**不画 overlay**,而不是退回 `hitcircleoverlay.png`。
   * 所以调用方拿到这个名字后,overlay 一律用 `${name}overlay` 查,不要另做回退。
   */
  private drawCirclePiece(
    object: SimHitObject,
    cx: number,
    cy: number,
    radius: number,
    grow: number,
    palette: ComboPalette,
  ): string | null {
    // 转盘不用圈贴图
    if (object.kind === 'spinner') return null;

    const prefix = object.kind === 'slider' ? 'sliderstartcircle' : null;
    const name = circleComponentName(this.layers, prefix);

    // 染色版优先:只有圈体染 combo 色,overlay 不染
    const base = this.tinted.get(name, palette.indexOf(object)) ?? this.sprites.get(name);
    if (base === null) return null;

    drawSprite(this.ctx, base, spriteQuad(base, cx, cy, radius, CIRCLE_MAX_DISPLAY, grow));

    // overlay 在数字之下的那种情形在这里画;之上的情形由调用方在数字之后画
    if (!this.overlayAboveNumber()) this.drawCircleOverlay(name, cx, cy, radius, grow);

    return name;
  }

  /** overlay 那一层。单独抽出来是因为它的绘制**位置**取决于一个 skin.ini 开关。 */
  private drawCircleOverlay(
    name: string,
    cx: number,
    cy: number,
    radius: number,
    grow: number,
  ): void {
    const overlay = this.sprites.get(`${name}overlay`);
    if (overlay === null) return;

    drawSprite(
      this.ctx,
      overlay,
      spriteQuad(overlay, cx, cy, radius, CIRCLE_MAX_DISPLAY, grow),
    );
  }

  /**
   * `HitCircleOverlayAboveNumber` —— **默认 true**。
   *
   * ⚠️ lazer **同时认那个拼写错误的键**:
   * ```csharp
   * // OsuLegacySkinTransformer.cs:317-321
   * // HitCircleOverlayAboveNumer (with typo) should still be supported for now.
   * return base.GetConfig<...>(HitCircleOverlayAboveNumber) ??
   *        base.GetConfig<...>(HitCircleOverlayAboveNumer);
   * ```
   * 用户的真实皮肤设的正是**拼错**那个(`HitCircleOverlayAboveNumer: 1`),
   * 所以只认正确拼写的实现会在这张皮肤上静默走错分支。
   *
   * 值的解析也照 lazer 来:`1`/`0`/`true`/`false` 都吃,非零整数为真
   * (`LegacySkin.cs:356-365`,注释提到有皮肤写 `2`)。
   */
  private overlayAboveNumber(): boolean {
    const raw = this.skin?.ini.raw;
    const value =
      raw?.get('HitCircleOverlayAboveNumber') ?? raw?.get('HitCircleOverlayAboveNumer');

    if (value === undefined) return true;

    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;

    const n = Number.parseInt(lower, 10);
    return Number.isFinite(n) ? n !== 0 : true;
  }

  /**
   * 圈内的 combo 序号。
   *
   * 有字体贴图就用贴图(排版规则见 `skin/numberLayout.ts`),否则退回 canvas 文字。
   */
  private drawComboNumber(indexInCombo: number, cx: number, cy: number, radius: number): void {
    const { ctx } = this;
    const prefix = this.skin?.ini.hitCirclePrefix ?? 'default';
    const overlap = this.skin?.ini.hitCircleOverlap ?? -2;

    const digits = String(indexInCombo).split('');
    const glyphs = digits.map((d) => this.sprites.get(`${prefix}-${d}`));

    if (!glyphs.includes(null)) {
      const layout = layoutHitCircleNumber(glyphs, overlap);
      drawTextLayout(ctx, layout, cx, cy, radius);
      return;
    }

    // 没有字体贴图 —— 退回自绘。这不是 osu 行为,只为可读性
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = `${Math.round(radius * 0.9)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(indexInCombo), cx, cy);
  }

  /**
   * 全部 approach circle —— **画在所有物件之上的独立图层**。
   *
   * ## 为什么单独一趟
   *
   * 核 `OsuPlayfield.cs:60-74`,自下而上:
   * ```csharp
   * Smoke, spinnerProxies, FollowPoints, judgementLayer,
   * HitObjectContainer,
   * judgementAboveHitObjectLayer,
   * approachCircles = new ProxyContainer { ... },
   * ```
   * 而 `:122-125` 把每个 hit circle 的 approach circle **proxy 进那个容器**:
   * ```csharp
   * case DrawableHitCircle hitCircle:
   *     approachCircles.Add(hitCircle.ProxiedLayer.CreateProxy());
   * ```
   *
   * 所以**任何** approach circle 都在**所有**物件之上 —— 密集段里这个差别很明显:
   * 跟着各自物件画时,后一个物件的圈体会盖住前一个物件的 approach circle。
   */
  private drawApproachCircles(timeline: ReplayTimeline, state: PlaybackState): void {
    const { ctx } = this;
    const radius = radiusFromCS(timeline.beatmap.difficulty.circleSize) * this.scale;
    const preempt = preemptFromAR(timeline.beatmap.difficulty.approachRate);
    const palette = this.paletteOf(timeline.beatmap);

    const sprite = this.sprites.get('approachcircle');

    for (let i = state.activeObjects.length - 1; i >= 0; i--) {
      const { object, result } = state.activeObjects[i]!;
      if (object.kind === 'spinner') continue;

      const hitTime = result?.hitTime ?? null;
      const alpha = approachAlphaAt(object.startTime, preempt, state.time, hitTime);
      if (alpha <= 0) continue;

      const cx = this.toScreenX(object.stackedX);
      const cy = this.toScreenY(object.stackedY);
      const scale = approachScaleAt(object.startTime, preempt, state.time);

      ctx.save();
      ctx.globalAlpha = alpha;

      if (sprite !== null) {
        // ⚠️ "1 倍"的基准是**贴图自身的显示尺寸**,不是 2×Radius ——
        // ScaleTo(1) 缩的是那个 Scale=4 的包装容器,里面的 sprite 是原生尺寸。
        // 也**不要**加 128/118:那是 Argon/Triangles 的补偿,legacy 没有
        drawSprite(
          ctx,
          this.tinted.get('approachcircle', palette.indexOf(object)) ?? sprite,
          spriteQuad(sprite, cx, cy, radius, CIRCLE_MAX_DISPLAY, scale),
        );
      } else {
        // 线框退化:用 radius × scale 近似(此时没有贴图尺寸可依据)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = Math.max(1, 1.5 * this.scale);
        ctx.beginPath();
        ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  /**
   * 滑条体 + 滑条球。
   *
   * ## snaking:只画路径的一段
   *
   * 滑条不是一出现就整条画出来的:先从头部**伸展**到尾部(`preempt / 3` 内完成),
   * 球划过之后再在球后面**收缩**掉。规则与三个易错点见 `sliderSnaking.ts`。
   *
   * ## 横截面:把深度缓冲的语义翻译成"不透明同心描边"
   *
   * osu! 真正的滑条体是 WebGL 三角带 + **每条滑条独立的深度缓冲双 pass**。
   * 核 webosu 的 `js/SliderMesh.js`:顶点属性带一个 `dist`(中心线 0、轮廓边 1),
   * `gl_Position.z` 直接取它;pass 1 只写深度求每像素的**最小 dist**,
   * pass 2 用 `depthFunc(EQUAL)` 只着色那一个 fragment。
   *
   * 净效果是**一条规则**:每个像素由"它到中心线最小距离处"的颜色着色,且只着一次。
   *
   * canvas2d 没有深度缓冲,但这条规则可以一比一翻译:
   *
   * 1. 把横截面渐变烘成 {@link BODY_LEVELS} 级**纯不透明**色
   * 2. 对**同一条完整路径**描边 K 次,`lineWidth` 由 `2r` 递减到 ~0
   * 3. 每遍都不透明 ⇒ 不可能累积;越窄的遍越晚画 ⇒ 每像素赢家就是距中心线最近的那级
   *
   * 第 3 点就是深度测试强制的那条规则,只是用绘制顺序替代了深度比较。
   *
   * ## 为什么不需要离屏 canvas
   *
   * 直接画在主画布上时,K 遍之间会互相混合 —— 但**只有在 `globalAlpha < 1` 时才会**。
   * 滑条体绝大部分生命周期是全不透明的(`alpha == 1`),那时每遍完全盖住上一遍,
   * 结果与离屏方案逐像素相同。淡入那 ~400ms 里中心会偏浓一点,是可接受的近似 ——
   * 换来省掉每帧每滑条一次离屏分配 + `drawImage`。
   *
   * ## 一处已修正的认知
   *
   * 原先注释里写"canvas2d 单遍粗折线在交叠处会变亮" —— **那是错的**。
   * canvas2d 把一次 `stroke()` 的整条路径当作**一个区域**填充,自重叠不重复合成。
   * 所以旧实现真正的毛病不是叠亮,而是横截面完全没有渐变(缺"管道感")。
   *
   * `object.path` 存的是**相对起点的偏移**,要加上堆叠后的起点。
   */
  private drawSliderBody(
    object: SimHitObject,
    radius: number,
    time: number,
    preempt: number,
    palette: ComboPalette,
  ): void {
    const { ctx } = this;

    const snake = snakeRangeAt(object, time, preempt);

    // 收缩完毕 —— 整条都不画。滑条球那段仍要走(球在 endTime 之前一直存在)
    if (snake.visible) {
      const track = palette.trackRgbOf(object);
      const border = palette.borderRgb;

      ctx.save();
      // 圆头 + 圆角是"管道"观感的一半:少了它折点处会出现尖角,首尾是平口
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 路径只建一次,K 遍描边复用 —— 建路径比描边贵,别放进循环
      this.tracePathRange(object, snake.from, snake.to);

      // 屏上越小的滑条不需要那么多级 —— 半径 10px 时 32 级里大半会落在同一个像素上
      const levels = Math.max(4, Math.min(BODY_LEVELS, Math.round(radius)));

      for (let i = 0; i < levels; i++) {
        // t: 0 = 最外圈(轮廓边),1 = 中心线。与 shader 里的 dist 反向,便于由宽到窄循环
        const t = i / (levels - 1);
        ctx.strokeStyle = bodyLevelColour(t, track, border);
        // 最后一级宽度不能到 0,否则 round 线帽会退化成看不见
        ctx.lineWidth = Math.max(1, radius * 2 * (1 - t));
        ctx.stroke();
      }

      ctx.restore();
    }

    // 滑条球:只在滑条进行中画
    if (time < object.startTime || time > object.endTime) return;

    const ball = sliderBallAt(object, time);
    ctx.strokeStyle = '#ffdd55';
    ctx.lineWidth = Math.max(1.5, 2 * this.scale);
    ctx.beginPath();
    ctx.arc(this.toScreenX(ball.x), this.toScreenY(ball.y), radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * 把路径的 `[from, to]` 段建成当前 path。
   *
   * 两个端点用 {@link pathOffsetAt} **精确插值**,中间才用原始采样点 ——
   * 若把端点也吸附到最近的采样点,伸展与收缩会以采样间距(2 osu 单位)为步长跳动,
   * 肉眼能看出来"一格一格地长"。
   */
  private tracePathRange(object: SimHitObject, from: number, to: number): void {
    const { ctx } = this;
    const { path } = object;

    const sx = (dx: number) => this.toScreenX(object.stackedX + dx);
    const sy = (dy: number) => this.toScreenY(object.stackedY + dy);

    const head = pathOffsetAt(path, from);
    ctx.beginPath();
    ctx.moveTo(sx(head.x), sy(head.y));

    const { first, last } = pathRangeBounds(path, from, to);
    for (let k = first; k <= last; k++) ctx.lineTo(sx(path.x[k]!), sy(path.y[k]!));

    const tail = pathOffsetAt(path, to);
    ctx.lineTo(sx(tail.x), sy(tail.y));
  }

  /**
   * 光标拖尾。
   *
   * ## 两种模式,判据是 `FindProvider`
   *
   * 核 `LegacyCursorTrail.cs:44-45`:
   * ```csharp
   * // Stable always chooses cursor trail disjoint behaviour based on the cursor
   * // texture lookup source, so we need to fetch where that occurred.
   * var cursorProvider = skinSource.FindProvider(s => s.GetTexture("cursor") != null);
   * DisjointTrail = cursorProvider?.GetTexture("cursormiddle") == null;
   * ```
   * 判据是「**提供 `cursor` 的那一层**有没有 `cursormiddle`」,不是整个栈 ——
   * 与圈类命名决策同一个模式。
   *
   * - 有 `cursormiddle` → **connected**:按弧长补点、500ms 淡出、**Additive 混合**
   * - 没有 → **disjoint**:16.667ms 时间网格、150ms 淡出、普通混合
   *
   * ## 没有 cursortrail 贴图时退回原来的折线
   *
   * 那个折线不是 osu 行为,只是"能看出光标轨迹"的调试画法。
   */
  private drawTrail(timeline: ReplayTimeline, state: PlaybackState): void {
    const sprite = this.sprites.get('cursortrail');
    if (sprite === null) {
      this.drawFallbackTrail(timeline, state);
      return;
    }

    const { ctx } = this;
    const mode = this.trailMode();
    const fade = TRAIL_FADE_MS[mode];

    // 光标类贴图的尺寸:display 尺寸再除 1.6(见 cursor.ts 里那段说明)
    const size = (sprite.width / sprite.scale / STABLE_MAGIC_SCALE_FACTOR) * this.scale;

    ctx.save();
    // connected 模式是加法混合 —— 交叠处更亮,这是 osu 的观感
    if (mode === 'connected') ctx.globalCompositeOperation = 'lighter';

    for (const t of this.trailPointTimes(timeline, state, mode, fade)) {
      const at = cursorAt(timeline.frames, t);
      ctx.globalAlpha = trailAlphaAt(state.time - t, fade);
      drawSprite(
        ctx,
        sprite,
        {
          sx: 0, sy: 0, sw: sprite.width, sh: sprite.height,
          dx: this.toScreenX(at.x) - size / 2,
          dy: this.toScreenY(at.y) - size / 2,
          dw: size, dh: size,
        },
      );
    }

    ctx.restore();
  }

  /**
   * 拖尾点的时刻表。
   *
   * disjoint 是纯网格,**完全的纯函数**(见 `cursor.ts`)。
   * connected 需要按弧长采样 —— 这里做的是**近似**:直接用回放帧的时刻。
   *
   * ⚠️ 这个近似要写清楚:lazer 的 connected 模式沿光标轨迹每
   * `cursortrail.DisplayWidth / 2.5` 个 osu 单位放一个点,所以**移动快时点更密**;
   * 我们按帧放点,于是密度取决于回放的采样率。两者在慢速移动时接近,
   * 急动时我们的点会偏稀。弧长积分是正解,留待需要时再做。
   */
  private trailPointTimes(
    timeline: ReplayTimeline,
    state: PlaybackState,
    mode: TrailMode,
    fade: number,
  ): number[] {
    if (mode === 'disjoint') return disjointTrailTimes(state.time, fade);

    const { frames } = timeline;
    const end = lastIndexAtOrBefore(frames.time, frames.count, state.time);
    if (end < 0) return [];

    const start = Math.max(0, lastIndexAtOrBefore(frames.time, frames.count, state.time - fade));

    const out: number[] = [];
    for (let i = end; i >= start; i--) out.push(frames.time[i]!);
    return out;
  }

  /**
   * `DisjointTrail` 的判定 —— 见 {@link drawTrail} 的注释。
   *
   * 提供 `cursor` 的那一层里没有 `cursormiddle` ⇒ disjoint。
   */
  private trailMode(): TrailMode {
    const provider = findProvider(
      this.layers,
      (layer) => resolveTexture(layer.files, 'cursor') !== null,
    );
    if (provider === null) return 'disjoint';

    return resolveTexture(provider.files, 'cursormiddle') === null ? 'disjoint' : 'connected';
  }

  /** 没有 `cursortrail` 贴图时的调试画法(非 osu 行为)。 */
  private drawFallbackTrail(timeline: ReplayTimeline, state: PlaybackState): void {
    const { frames } = timeline;
    if (frames.count === 0) return;

    const end = lastIndexAtOrBefore(frames.time, frames.count, state.time);
    if (end < 0) return;

    const start = Math.max(0, lastIndexAtOrBefore(frames.time, frames.count, state.time - TRAIL_MS));

    const { ctx } = this;
    // 圆头线帽只应作用于拖尾。不 save/restore 的话,后面画的光标会跟着变成圆头
    // —— 而拖尾在时间轴两端不绘制,于是光标外观会随"这一帧有没有拖尾"而变。
    ctx.save();
    ctx.lineWidth = Math.max(1, 1.5 * this.scale);
    ctx.lineCap = 'round';

    for (let i = start; i < end; i++) {
      // 越旧越淡
      const age = (state.time - frames.time[i]!) / TRAIL_MS;
      ctx.strokeStyle = `rgba(255, 102, 170, ${(1 - age) * 0.7})`;
      ctx.beginPath();
      ctx.moveTo(this.toScreenX(frames.x[i]!), this.toScreenY(frames.y[i]!));
      ctx.lineTo(this.toScreenX(frames.x[i + 1]!), this.toScreenY(frames.y[i + 1]!));
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 光标。
   *
   * ## 只有 `cursor` 会转会缩
   *
   * `LegacyCursor.cs:37-51` 里 `ExpandTarget` 是 `cursor` 那一张,`cursormiddle`
   * 是它的兄弟节点。而 `Expand()` / `Spin()` 都只作用于 `ExpandTarget` ——
   * 所以 `cursormiddle` 永远不转不缩。
   *
   * ## 三个开关都默认 **true**
   *
   * `CursorRotate` / `CursorExpand` / `CursorCentre`(`LegacyCursor.cs:34-35`、
   * `OsuCursor.cs:118`)。用户那张皮肤把前两个设成 0,所以在它上面既不转也不缩 ——
   * 但别的皮肤会,所以都实现了。
   */
  private drawCursor(timeline: ReplayTimeline, state: PlaybackState): void {
    const base = this.sprites.get('cursor');
    if (base === null) {
      this.drawFallbackCursor(state);
      return;
    }

    const { ctx } = this;
    const cx = this.toScreenX(state.cursor.x);
    const cy = this.toScreenY(state.cursor.y);

    const expand = cursorExpandScaleAt(timeline.frames, state.time, this.iniFlag('CursorExpand'));
    const spin = this.iniFlag('CursorRotate');

    ctx.save();
    ctx.translate(cx, cy);

    // 只有 cursor 这一张受旋转与放大影响。
    // ⚠️ `CursorRotate` 关掉时**完全不发 rotate**,而不是 rotate(0) ——
    // 后者会让"关掉旋转"的皮肤仍然产生一次多余的变换调用,
    // 使调用序列与真正无旋转的情形不一致(测试也就分不出两者)
    ctx.save();
    if (spin) ctx.rotate((cursorRotationAt(state.time) * Math.PI) / 180);
    this.drawCursorSprite(base, expand);
    ctx.restore();

    const middle = this.sprites.get('cursormiddle');
    if (middle !== null) this.drawCursorSprite(middle, 1);

    ctx.restore();
  }

  /**
   * 画一张光标类贴图,**以当前变换原点为中心**。
   *
   * 尺寸 = `display 尺寸 / 1.6 × 缩放`。那个 1.6 是 `STABLE_MAGIC_SCALE_FACTOR` ——
   * 光标贴图是按 1024×768 参考屏幕 1:1 设计的,而判定区在那个屏幕下被放大了 1.6 倍。
   * 见 `cursor.ts` 头部。
   *
   * ⚠️ `CursorCentre` 为 false 时 osu 把贴图**左上角**对准光标位置(`Anchor.TopLeft`)。
   * 默认是 true(居中)。
   */
  private drawCursorSprite(sprite: SkinSprite, scale: number): void {
    const w = (sprite.width / sprite.scale / STABLE_MAGIC_SCALE_FACTOR) * this.scale * scale;
    const h = (sprite.height / sprite.scale / STABLE_MAGIC_SCALE_FACTOR) * this.scale * scale;

    const centred = this.iniFlag('CursorCentre');
    const dx = centred ? -w / 2 : 0;
    const dy = centred ? -h / 2 : 0;

    drawSprite(this.ctx, sprite, {
      sx: 0, sy: 0, sw: sprite.width, sh: sprite.height,
      dx, dy, dw: w, dh: h,
    });
  }

  /**
   * 读一个布尔型 skin.ini 开关,**默认 true**。
   *
   * 值的解析照 `LegacySkin.cs:356-365`:`1`/`0`/`true`/`false` 都吃,
   * 非零整数为真(源码注释提到有皮肤写 `2`)。
   */
  private iniFlag(key: string): boolean {
    const value = this.skin?.ini.raw.get(key);
    if (value === undefined) return true;

    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;

    const n = Number.parseInt(lower, 10);
    return Number.isFinite(n) ? n !== 0 : true;
  }

  /** 没有 `cursor` 贴图时的调试画法(非 osu 行为)。 */
  private drawFallbackCursor(state: PlaybackState): void {
    const { ctx } = this;
    const { cursor } = state;

    const cx = this.toScreenX(cursor.x);
    const cy = this.toScreenY(cursor.y);
    const keys = normalizeKeys(cursor.keys);

    // 按下任意键时放大并变色
    const pressed = keys !== 0;
    const size = (pressed ? 9 : 6) * this.scale;

    ctx.fillStyle = pressed ? '#ffdd55' : '#ff66aa';
    ctx.beginPath();
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(1, 1.5 * this.scale);
    ctx.stroke();

    // 两个键位分别用左右半环表示,方便肉眼核对按键解析是否正确
    if (keys & ReplayKey.M1) this.drawKeyArc(cx, cy, size + 5 * this.scale, Math.PI, Math.PI * 2);
    if (keys & ReplayKey.M2) this.drawKeyArc(cx, cy, size + 5 * this.scale, 0, Math.PI);
  }

  private drawKeyArc(cx: number, cy: number, radius: number, from: number, to: number): void {
    const { ctx } = this;
    ctx.strokeStyle = '#ffdd55';
    ctx.lineWidth = Math.max(2, 3 * this.scale);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, from, to);
    ctx.stroke();
  }
}
