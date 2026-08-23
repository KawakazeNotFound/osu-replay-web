import { ReplayKey, normalizeKeys } from '../core/replay/frames';
import { radiusFromCS } from '../core/sim/difficulty';
import type { PlaybackState, ReplayTimeline } from '../core/sim/types';
import { lastIndexAtOrBefore } from '../core/util/search';

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

/** 光标拖尾显示的时长(ms,谱面时间) */
const TRAIL_MS = 400;

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 2d context');
    this.ctx = ctx;
  }

  /** 按容器尺寸与 devicePixelRatio 重算画布分辨率。窗口 resize 时调用。 */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));

    // 等比缩放并居中(letterbox),留 5% 边距
    const fit = Math.min(
      this.canvas.width / PLAYFIELD_WIDTH,
      this.canvas.height / PLAYFIELD_HEIGHT,
    );
    this.scale = fit * 0.9;
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
   * 物件占位绘制:圈 + approach circle。
   *
   * M0 只画轮廓,滑条也退化成一个圈(滑条体是 M2 的专项,见 TECH-NOTES D4)。
   */
  private drawHitObjects(timeline: ReplayTimeline, state: PlaybackState): void {
    const { ctx } = this;
    const radius = radiusFromCS(timeline.beatmap.difficulty.circleSize) * this.scale;

    // 倒序绘制:osu! 的图层约定是越早的物件在越上层
    for (let i = state.activeObjects.length - 1; i >= 0; i--) {
      const active = state.activeObjects[i]!;
      const { object } = active;

      const cx = this.toScreenX(object.x);
      const cy = this.toScreenY(object.y);

      ctx.strokeStyle = object.kind === 'spinner' ? '#7f7fff' : '#5ac8fa';
      ctx.lineWidth = Math.max(1.5, 2 * this.scale);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      // approach circle:从 preempt 开始时的 4 倍半径收缩到 1 倍
      const untilHit = object.startTime - state.time;
      if (untilHit > 0) {
        const preemptRadius = radius * (1 + 3 * Math.min(1, untilHit / 800));
        ctx.strokeStyle = 'rgba(90, 200, 250, 0.35)';
        ctx.lineWidth = Math.max(1, 1.5 * this.scale);
        ctx.beginPath();
        ctx.arc(cx, cy, preemptRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
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
