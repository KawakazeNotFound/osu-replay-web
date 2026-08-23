import type { Clock } from './Clock';

export interface AudioClockOptions {
  /**
   * 低于此倍速时静音。
   *
   * `AudioBufferSourceNode.playbackRate` 在极低倍速下音频质量会崩坏,逐帧模式下
   * 更是完全无意义。见 TECH-NOTES D3。
   */
  muteBelowRate?: number;
}

/**
 * 音频驱动的时钟。
 *
 * 时间从 `AudioContext.currentTime` 推导,而**不是** `<audio>.currentTime`。
 * 后者的更新粒度受浏览器实现限制,抖动可达数十 ms,足以让 approach circle
 * 视觉上抖动。`AudioContext.currentTime` 由音频硬件时钟驱动,单调且采样精确。
 * 见 TECH-NOTES C2。
 *
 * 推导公式(播放中):
 * ```
 * currentTime = anchorBeatmapMs + (ctx.currentTime - anchorCtxSec) * 1000 * rate
 * ```
 *
 * `play` / `seek` / `setRate` 都归约成同一个操作:停掉当前的
 * `AudioBufferSourceNode`,以新 offset 建一个新的,重设 anchor。
 *
 * 没有音频 buffer 时时钟依然正常走(自由运行),所以 M0 可以先不接音频。
 */
export class AudioClock implements Clock {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly muteBelowRate: number;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  private _rate = 1;
  private _running = false;

  /** anchor:谱面时间与 AudioContext 时间的对齐点。 */
  private anchorBeatmapMs = 0;
  private anchorCtxSec = 0;

  constructor(ctx: AudioContext, options: AudioClockOptions = {}) {
    this.ctx = ctx;
    this.muteBelowRate = options.muteBelowRate ?? 0.25;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
  }

  get currentTime(): number {
    if (!this._running) return this.anchorBeatmapMs;
    return this.anchorBeatmapMs + (this.ctx.currentTime - this.anchorCtxSec) * 1000 * this._rate;
  }

  get rate(): number {
    return this._rate;
  }

  get isRunning(): boolean {
    return this._running;
  }

  /** 音频总长(ms)。无 buffer 时为 0。 */
  get durationMs(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  /** 换音频。会保持当前时间与播放状态。 */
  setBuffer(buffer: AudioBuffer | null): void {
    const wasRunning = this._running;
    const t = this.currentTime;

    this.pause();
    this.buffer = buffer;
    this.anchorBeatmapMs = t;

    if (wasRunning) this.play();
  }

  play(): void {
    if (this._running) return;

    // AudioContext 在用户手势之前是 suspended 的,这里只是尽力 resume。
    void this.ctx.resume();

    this.anchorCtxSec = this.ctx.currentTime;
    this._running = true;
    this.startSource(this.anchorBeatmapMs);
  }

  pause(): void {
    if (!this._running) return;

    const t = this.currentTime;
    this.stopSource();
    this.anchorBeatmapMs = t;
    this._running = false;
  }

  seek(ms: number): void {
    if (!this._running) {
      this.anchorBeatmapMs = ms;
      return;
    }
    this.restartAt(ms);
  }

  setRate(rate: number): void {
    if (rate <= 0) throw new RangeError(`rate must be > 0, got ${rate}`);

    const t = this.currentTime;
    this._rate = rate;

    if (this._running) this.restartAt(t);
  }

  dispose(): void {
    this.stopSource();
    this.gain.disconnect();
  }

  /** 以 beatmapMs 为新起点重建音频源并重设 anchor。仅在播放中调用。 */
  private restartAt(beatmapMs: number): void {
    this.stopSource();
    this.anchorBeatmapMs = beatmapMs;
    this.anchorCtxSec = this.ctx.currentTime;
    this.startSource(beatmapMs);
  }

  private startSource(beatmapMs: number): void {
    // 无音频 → 时钟自由运行。已过音频末尾 → 同理。
    if (!this.buffer) return;
    if (beatmapMs >= this.durationMs) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    src.connect(this.gain);

    this.gain.gain.value = this._rate < this.muteBelowRate ? 0 : 1;

    if (beatmapMs < 0) {
      // lead-in:谱面时间还没走到音频起点。不能用负 offset,
      // 而是把音频源调度到未来的某个时刻启动。
      const delaySec = -beatmapMs / 1000 / this._rate;
      src.start(this.ctx.currentTime + delaySec, 0);
    } else {
      src.start(this.ctx.currentTime, beatmapMs / 1000);
    }

    this.source = src;
  }

  private stopSource(): void {
    if (!this.source) return;

    try {
      this.source.stop();
    } catch {
      // 源可能已自然播完或从未启动 —— 两种情况下 stop() 都可能抛,忽略。
    }
    this.source.disconnect();
    this.source = null;
  }
}
