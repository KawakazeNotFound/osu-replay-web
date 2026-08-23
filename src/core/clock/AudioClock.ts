import type { Clock } from './Clock';

export interface AudioClockOptions {
  /**
   * 低于此倍速时静音。
   *
   * `AudioBufferSourceNode.playbackRate` 在极低倍速下音频质量会崩坏,逐帧模式下
   * 更是完全无意义。见 TECH-NOTES D3。
   */
  muteBelowRate?: number;

  /** 初始音量(0..1 的**感知**音量,见 {@link AudioClock.setVolume})。默认 1。 */
  initialVolume?: number;
}

/**
 * 音量变化的过渡时长(秒)。
 *
 * ⚠️ **直接给 `gain.value` 赋值会爆音**(click / zipper noise)—— 增益是逐采样
 * 生效的,瞬间跳变等于在波形里插入一个阶跃。所以一律走短斜坡。
 *
 * 15ms 是个折中:足够短到感觉是"立即"响应,又足够长到听不出咔哒声。
 */
const VOLUME_RAMP_SECONDS = 0.015;

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

  /** 用户设定的**感知**音量(0..1)。见 {@link setVolume}。 */
  private _volume = 1;
  private _muted = false;

  /** anchor:谱面时间与 AudioContext 时间的对齐点。 */
  private anchorBeatmapMs = 0;
  private anchorCtxSec = 0;

  constructor(ctx: AudioContext, options: AudioClockOptions = {}) {
    this.ctx = ctx;
    this.muteBelowRate = options.muteBelowRate ?? 0.25;
    this._volume = clamp01(options.initialVolume ?? 1);

    this.gain = ctx.createGain();
    // 构造时直接赋值(此刻还没有任何声音在播,不会爆音)
    this.gain.gain.value = this.effectiveGain();
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

  /** 用户设定的感知音量(0..1)。 */
  get volume(): number {
    return this._volume;
  }

  get muted(): boolean {
    return this._muted;
  }

  /**
   * 当前实际生效的线性增益(0..1)。
   *
   * 与 {@link volume} 不同:这里已经算进了静音开关与"低倍速静音"规则,
   * 而且做过感知曲线换算。UI 想显示"现在到底出不出声"就看这个。
   */
  get effectiveVolume(): number {
    return this.effectiveGain();
  }

  /**
   * 设定音量。
   *
   * ⚠️ 参数是**感知**音量(0..1),内部会平方后再作为线性增益 ——
   * 人耳对声压的感受近似对数,把滑块位置直接当增益用会觉得"前半段几乎没变化、
   * 后半段突然很响"。平方是最简单有效的近似(相当于 -∞ ~ 0 dB 的平滑映射)。
   *
   * 变化走 15ms 斜坡,避免爆音 —— 见 {@link VOLUME_RAMP_SECONDS}。
   */
  setVolume(volume: number): void {
    this._volume = clamp01(volume);
    this.rampGain();
  }

  /** 静音开关。不改 {@link volume},所以取消静音后回到原来的音量。 */
  setMuted(muted: boolean): void {
    this._muted = muted;
    this.rampGain();
  }

  toggleMuted(): void {
    this.setMuted(!this._muted);
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

    // 倍速影响"低倍速静音"规则,所以增益要跟着更新 ——
    // 而且**暂停时也要更新**,否则下次 play 之前 effectiveVolume 是过期值
    this.rampGain();

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

    // 增益由 rampGain 统一维护(setRate / setVolume / setMuted 都会调它),
    // 这里不再直接赋值 —— 否则用户在播放中调的音量会被下一次 restartAt 冲掉

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

  /**
   * 当前应该生效的线性增益。
   *
   * 三个因素叠加:静音开关、低倍速静音规则(TECH-NOTES D3)、感知音量曲线。
   */
  private effectiveGain(): number {
    if (this._muted) return 0;
    if (this._rate < this.muteBelowRate) return 0;

    // 感知 → 线性:平方。见 setVolume 的注释
    return this._volume * this._volume;
  }

  /**
   * 把增益平滑过渡到目标值。
   *
   * 三步是 Web Audio 的标准写法,少一步都会出问题:
   * 1. `cancelScheduledValues` —— 不取消的话多次快速调节会叠加出乱七八糟的曲线
   * 2. `setValueAtTime(当前值)` —— 给斜坡一个明确起点;省掉它斜坡会从上一个
   *    已调度事件的值开始,快速拖动滑块时听起来会"追不上"
   * 3. `linearRampToValueAtTime` —— 真正的过渡
   */
  private rampGain(): void {
    const target = this.effectiveGain();
    const now = this.ctx.currentTime;
    const param = this.gain.gain;

    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + VOLUME_RAMP_SECONDS);
  }
}

/**
 * 钳制到 0..1。
 *
 * ⚠️ 非有限值(NaN / ±Infinity)一律归 **0** 而不是 1。
 * 理由:若某处算出了 Infinity,静音是安全的失败方式,突然满音量会炸耳朵。
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
