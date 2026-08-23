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

  constructor(clock: Clock, timeline: ReplayTimeline) {
    this.clock = clock;
    this.timeline = timeline;
  }

  get currentTime(): number {
    return this.clock.currentTime;
  }

  get rate(): number {
    return this.clock.rate;
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

  setRate(rate: number): void {
    this.clock.setRate(rate);
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
