import { ReplayKey, normalizeKeys } from '../core/replay/frames';
import { preemptFromAR, radiusFromCS } from '../core/sim/difficulty';
import { sliderBallAt } from '../core/sim/sliderTracking';
import {
  HitResult,
  type PlaybackState,
  type ReplayTimeline,
  type SimBeatmap,
  type SimHitObject,
} from '../core/sim/types';
import { lastIndexAtOrBefore } from '../core/util/search';
import { buildComboPalette, type ComboPalette } from './comboColours';

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
const HIT_FADE_MS = 240;

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

    ctx.fillStyle = '#0f0f14';
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
   * 物件绘制:滑条体 + 圈 + approach circle + 命中淡出。
   *
   * ## 命中后的消失
   *
   * 关键是**查 `active.result`**,而不是只按时间窗画。圈一旦被判定,就从
   * `hitTime` 起走 {@link HIT_FADE_MS} 的淡出(同时轻微扩散),淡完就不画。
   * miss 的物件用红色标出,不淡出扩散。
   *
   * ⚠️ 这里仍然**不持有跨帧状态** —— 淡出进度是从 `state.time - hitTime` 算出来的,
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
      let alpha = untilHit > 0 ? clamp01((preempt - untilHit) / fadeIn) : 1;
      let grow = 1;

      // 命中淡出。滑条要等整条走完(endTime)才消失,所以只对非滑条生效
      const hitTime = result?.hitTime ?? null;
      if (hitTime !== null && object.kind === 'circle') {
        const since = state.time - hitTime;
        if (since >= HIT_FADE_MS) continue; // 淡完了,不画
        if (since >= 0) {
          const progress = since / HIT_FADE_MS;
          alpha = 1 - progress;
          grow = 1 + 0.4 * progress; // 命中瞬间轻微扩散
        }
      }

      // 用**堆叠后**的坐标 —— osu 会把位置相近、时间相邻的物件依次错开,
      // 而 lazer 的命中检测也是基于 StackedPosition。见 sim/stacking.ts
      const cx = this.toScreenX(object.stackedX);
      const cy = this.toScreenY(object.stackedY);

      const missed = result !== null && result.result === HitResult.Miss;

      ctx.save();
      ctx.globalAlpha = alpha;

      // 滑条体:画在圈底下
      if (object.kind === 'slider' && object.path.count > 0) {
        this.drawSliderBody(object, radius, state.time, palette);
      }

      ctx.strokeStyle =
        missed ? '#ff4d6d'
        : object.kind === 'spinner' ? '#7f7fff'
        : palette.colourOf(object);
      ctx.lineWidth = Math.max(1.5, 2 * this.scale);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * grow, 0, Math.PI * 2);
      ctx.stroke();

      // combo 内序号。皮肤系统(M4)会换成 default-N 贴图
      if (object.kind !== 'spinner' && hitTime === null) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.font = `${Math.round(radius * 0.9)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(object.indexInCombo), cx, cy);
      }

      // approach circle:从 4 倍半径按真实 preempt 收缩到 1 倍
      if (untilHit > 0) {
        const approachRadius = radius * (1 + 3 * Math.min(1, untilHit / preempt));
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = Math.max(1, 1.5 * this.scale);
        ctx.beginPath();
        ctx.arc(cx, cy, approachRadius, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  /**
   * 滑条体 + 滑条球。
   *
   * ## 这是 canvas2d 的近似,不是正式实现
   *
   * osu! 真正的滑条体是一根**内淡外浓的管道**:最外圈 `SliderBorder` 色的边框,
   * 边框往内是轨道色,alpha 从内边缘往中心**递减**(所以中心能透出背景)。
   * 核 webosu 的 `SliderMesh.js` 用的常数是 `borderwidth = 0.128`、
   * 内边缘 alpha `0.8`、中心 alpha `0.3`。
   *
   * 这里只画两道描边近似,**横截面的渐变完全没有** —— 观感与 osu 差得明显。
   * 正式做法(把渐变烘成 K 级不透明色、由宽到窄描 K 遍)见 TECH-NOTES D14。
   *
   * 但"完全不画"比"画得不像"糟糕得多:没有滑条体根本看不出回放在跟什么。
   *
   * `object.path` 存的是**相对起点的偏移**,要加上堆叠后的起点。
   */
  private drawSliderBody(
    object: SimHitObject,
    radius: number,
    time: number,
    palette: ComboPalette,
  ): void {
    const { ctx } = this;
    const { path } = object;

    const px = (k: number) => this.toScreenX(object.stackedX + path.x[k]!);
    const py = (k: number) => this.toScreenY(object.stackedY + path.y[k]!);

    const track = palette.trackRgbOf(object);
    const border = palette.borderRgb;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    for (let k = 1; k < path.count; k++) ctx.lineTo(px(k), py(k));

    // 外圈 = 边框色,内部 = 轨道色。两者都是单遍描边,所以自相交处不会叠亮
    // (canvas2d 把一次 stroke() 的整条路径当成一个区域填充,自重叠不重复合成)
    ctx.strokeStyle = `rgba(${border.r}, ${border.g}, ${border.b}, 0.55)`;
    ctx.lineWidth = radius * 2;
    ctx.stroke();

    // borderwidth = 0.128 × 半径,取自 webosu 实测值
    ctx.strokeStyle = `rgba(${track.r}, ${track.g}, ${track.b}, 0.55)`;
    ctx.lineWidth = Math.max(1, radius * 2 * (1 - 0.128));
    ctx.stroke();

    ctx.restore();

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
