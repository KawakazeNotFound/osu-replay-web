/**
 * 时钟 —— 时间的唯一真相来源。
 *
 * 渲染层只读时钟,永不写。每一帧都是 `render(stateAt(clock.currentTime))`。
 * 快进 / 快退 / 逐帧 / 倍速 全部通过操作时钟实现,渲染层对此完全无感。
 */
export interface Clock {
  /** 当前谱面时间(ms)。可以为负 —— lead-in 阶段谱面时间早于音频起点。 */
  readonly currentTime: number;

  /** 播放倍速。始终 > 0。 */
  readonly rate: number;

  readonly isRunning: boolean;

  play(): void;
  pause(): void;
  seek(ms: number): void;
  setRate(rate: number): void;
}

/**
 * 手动时钟:时间只在被显式设置时改变,不会自行流动。
 *
 * 用途:
 * - 逐帧步进(每次 `advance(1000 / fps)`)
 * - 单元测试(不需要 AudioContext,可在 Node 里跑)
 */
export class ManualClock implements Clock {
  private _time: number;
  private _rate = 1;
  private _running = false;

  constructor(initialTime = 0) {
    this._time = initialTime;
  }

  get currentTime(): number {
    return this._time;
  }

  get rate(): number {
    return this._rate;
  }

  get isRunning(): boolean {
    return this._running;
  }

  /** 注意:置为 true 后时间仍不会自行流动,需调用 {@link advance}。 */
  play(): void {
    this._running = true;
  }

  pause(): void {
    this._running = false;
  }

  seek(ms: number): void {
    this._time = ms;
  }

  setRate(rate: number): void {
    if (rate <= 0) throw new RangeError(`rate must be > 0, got ${rate}`);
    this._rate = rate;
  }

  /** 手动推进时间。deltaMs 可为负(倒退)。 */
  advance(deltaMs: number): void {
    this._time += deltaMs;
  }
}
