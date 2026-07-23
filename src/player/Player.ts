/**
 * Silent playback clock: tracks presentation time (ms) over a fixed duration with
 * play/pause/seek, deriving elapsed time from a pluggable monotonic clock. Used when no
 * audio clock is available; when audio is present, drive it via `setClockFn` with the
 * audio clock so both stay in sync.
 */
export class Player {
  private _currentTimeMs = 0;
  private _playing = false;
  private _lastClockMs = 0;
  private _clockFn: () => number = () => performance.now();
  readonly durationMs: number;

  constructor(durationMs: number) {
    this.durationMs = durationMs;
  }

  /** Replace the time source. `fn` must return monotonically increasing ms; pass null to restore `performance.now()`. */
  setClockFn(fn: (() => number) | null): void {
    this._clockFn = fn ?? (() => performance.now());
  }

  /** Current presentation time in ms, clamped to `[0, durationMs]`. */
  get currentTimeMs(): number {
    if (!this._playing) return this._currentTimeMs;
    const elapsed = this._clockFn() - this._lastClockMs;
    return Math.min(this._currentTimeMs + elapsed, this.durationMs);
  }

  get isPlaying(): boolean {
    return this._playing;
  }

  /** Start advancing the clock; restarts from 0 if playback had reached the end. */
  play(): void {
    if (this._playing) return;
    if (this._currentTimeMs >= this.durationMs) {
      this._currentTimeMs = 0;
    }
    this._lastClockMs = this._clockFn();
    this._playing = true;
  }

  pause(): void {
    if (!this._playing) return;
    this._currentTimeMs = this.currentTimeMs;
    this._playing = false;
  }

  /** Jump to `ms` (clamped to `[0, durationMs]`) without changing the play/pause state. */
  seek(ms: number): void {
    const clamped = Math.max(0, Math.min(ms, this.durationMs));
    this._currentTimeMs = clamped;
    if (this._playing) {
      this._lastClockMs = this._clockFn();
    }
  }
}
