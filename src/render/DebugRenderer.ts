import { ReplayKey, normalizeKeys } from '../core/replay/frames';
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
import { buildComboPalette, type ComboPalette } from './comboColours';
import { snakeRangeAt } from './sliderSnaking';

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 2d context');
    this.ctx = ctx;
  }

  /** 取(或按需重建)该谱面的 combo 配色表。见 {@link palette}。 */
  private paletteOf(beatmap: SimBeatmap): ComboPalette {
    if (this.paletteFor !== beatmap || this.palette === null) {
      // 皮肤那一层还没有(M4),所以只传谱面 —— 链条会落到 osu 默认四色
      this.palette = buildComboPalette(beatmap);
      this.paletteFor = beatmap;
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
    this.drawTrail(timeline, state);
    this.drawCursor(state);
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

        ctx.strokeStyle =
          headMissed ? '#ff4d6d'
          : object.kind === 'spinner' ? '#7f7fff'
          : palette.colourOf(object);
        ctx.lineWidth = Math.max(1.5, 2 * this.scale);
        ctx.beginPath();
        ctx.arc(cx, cy, radius * head.grow, 0, Math.PI * 2);
        ctx.stroke();

        // combo 内序号。皮肤系统(M4)会换成 default-N 贴图。
        //
        // 条件是"还没被判定"(result === null)而不是 hitTime === null ——
        // 后者在 **miss** 时也成立,会让漏掉的圈一直顶着数字不放。
        //
        // 近似:真实行为是新版 legacy 皮肤把数字单独淡出 240/4 = 60ms 且不缩放
        // (`LegacyMainCirclePiece.cs:191`),我们直接让它消失。60ms 内几乎看不出来。
        if (object.kind !== 'spinner' && result === null) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.font = `${Math.round(radius * 0.9)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(object.indexInCombo), cx, cy);
        }

        // approach circle:从 4 倍半径按真实 preempt 收缩到 1 倍。
        // 在 head !== null 分支内 —— approach circle 是头的一部分,头淡完就没了
        if (untilHit > 0) {
          const approachRadius = radius * (1 + 3 * Math.min(1, untilHit / preempt));
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
          ctx.lineWidth = Math.max(1, 1.5 * this.scale);
          ctx.beginPath();
          ctx.arc(cx, cy, approachRadius, 0, Math.PI * 2);
          ctx.stroke();
        }
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
   * 注意实现方式:从 timeline.frames 里按 t 反查区间,**而不是**把每帧的光标位置
   * 追加进一个数组。后者在倒退时会画出错误的轨迹 —— 这正是「渲染层不得持有
   * 跨帧状态」这条约束想防的问题。
   */
  private drawTrail(timeline: ReplayTimeline, state: PlaybackState): void {
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

  private drawCursor(state: PlaybackState): void {
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
