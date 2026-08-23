import type { Clock } from '../core/clock/Clock';
import type { ReplayTimeline } from '../core/sim/types';
import { clamp, lastIndexAtOrBefore } from '../core/util/search';

/** 逐帧步进时假定的视频帧率(仅用于"步进一个显示帧"的语义)。 */
const NOMINAL_FPS = 60;

/**
 * 播放控制器 —— 把时钟操作收敛到一处。
 *
 * 设计上刻意保持极薄:因为 `stateAt` 是纯查询,所有控制操作最终都只是
 * "改变时钟的 t",没有任何状态需要同步。这正是预编译时间线架构的红利
 * —— 快进 / 快退 / 逐帧 / 倍速 在这里全是三五行代码。
 */
export class PlaybackController {
  timeline: ReplayTimeline;

  private readonly clock: Clock;

  /**
   * mod 带来的速度倍率(DT 1.5 / HT 0.75 / 其余 1)。
   *
   * 回放帧的时间戳是**谱面时间**,DT 的含义是谱面时间相对真实时间跑得更快。
   * 所以要忠实还原一段 DT 回放,时钟推进谱面时间的速率必须是 1.5×。
   *
   * 用户设定的倍速**乘在这之上**:`clock.rate = modRate * userRate`。
   * 于是"1× 播放"表示"按玩家当时的实际节奏播",而不是"谱面时间 1ms/ms"。
   */
  private _modRate = 1;
  private _userRate = 1;

  constructor(clock: Clock, timeline: ReplayTimeline) {
    this.clock = clock;
    this.timeline = timeline;
  }

  get currentTime(): number {
    return this.clock.currentTime;
  }

  /** 时钟实际速率 = modRate × userRate。 */
  get rate(): number {
    return this.clock.rate;
  }

  /** 用户设定的倍速(不含 mod 倍率)。UI 显示这个。 */
  get userRate(): number {
    return this._userRate;
  }

  /** mod 带来的倍率。 */
  get modRate(): number {
    return this._modRate;
  }

  get isPlaying(): boolean {
    return this.clock.isRunning;
  }

  /** 时钟自由运行时可能跑出时间轴范围,渲染前用它夹一下。 */
  get clampedTime(): number {
    return clamp(this.clock.currentTime, this.timeline.startTime, this.timeline.endTime);
  }

  togglePlay(): void {
    if (this.clock.isRunning) {
      this.clock.pause();
      return;
    }
    // 播完了再按播放 → 从头开始
    if (this.clock.currentTime >= this.timeline.endTime) {
      this.clock.seek(this.timeline.startTime);
    }
    this.clock.play();
  }

  pause(): void {
    this.clock.pause();
  }

  seek(ms: number): void {
    this.clock.seek(clamp(ms, this.timeline.startTime, this.timeline.endTime));
  }

  /** 相对跳转。快进 / 快退按钮走这里。 */
  skip(deltaMs: number): void {
    this.seek(this.clock.currentTime + deltaMs);
  }

  /** 设定用户倍速。实际时钟速率 = modRate × 这个值。 */
  setRate(rate: number): void {
    if (rate <= 0) throw new RangeError(`user rate must be > 0, got ${rate}`);

    this._userRate = rate;
    this.clock.setRate(this._modRate * rate);
  }

  /**
   * 设定 mod 倍率(载入回放时调用)。
   *
   * 用 `speedMultiplierOfLegacyMods(rawMods)` 取值。换回放时要重设,
   * 否则上一段 DT 回放的倍率会漏到下一段 NM 回放上。
   *
   * ⚠️ 只对 stable 回放准确:lazer 的 DT/HT 倍速可由玩家自定义(0.5×~2×),
   * legacy 位掩码里读不到。见 TECH-NOTES D7。
   */
  setModRate(rate: number): void {
    if (rate <= 0) throw new RangeError(`mod rate must be > 0, got ${rate}`);

    this._modRate = rate;
    this.clock.setRate(rate * this._userRate);
  }

  /**
   * 步进一个「显示帧」(1/60 秒)。
   *
   * 这是大多数人说"逐帧"时的意思 —— 等间隔的时间步。
   */
  stepDisplayFrame(direction: 1 | -1): void {
    this.clock.pause();
    this.seek(this.clock.currentTime + (direction * 1000) / NOMINAL_FPS);
  }

  /**
   * 步进一个「回放输入帧」。
   *
   * 与 {@link stepDisplayFrame} 是**两件不同的事**:.osr 里的帧是不等间隔的
   * (stable 约 60~1000Hz),想逐个查看"玩家这一次输入光标在哪、按了什么键"
   * 就必须按输入帧走。这是分析型用途的核心操作,预渲染视频方案永远做不到。
   */
  stepReplayFrame(direction: 1 | -1): void {
    this.clock.pause();

    const { frames } = this.timeline;
    if (frames.count === 0) return;

    const t = this.clock.currentTime;
    let i = lastIndexAtOrBefore(frames.time, frames.count, t);

    if (direction > 0) {
      // 找第一个严格晚于 t 的帧
      i = Math.max(0, i);
      while (i < frames.count && frames.time[i]! <= t) i++;
      if (i >= frames.count) i = frames.count - 1;
    } else {
      // 找最后一个严格早于 t 的帧
      if (i < 0) i = 0;
      while (i >= 0 && frames.time[i]! >= t) i--;
      if (i < 0) i = 0;
    }

    this.clock.seek(frames.time[i]!);
  }
}
