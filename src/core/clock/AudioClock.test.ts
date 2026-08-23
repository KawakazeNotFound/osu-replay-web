import { describe, expect, it } from 'vitest';

import { AudioClock } from './AudioClock';

/**
 * 假 AudioContext。
 *
 * `AudioClock` 的时间**完全**从 `ctx.currentTime` 推导,所以只要能手动推进它,
 * 就能在 Node 里确定性地测出全部时钟行为 —— 不需要音频设备,也不受真实时间影响。
 */
class FakeAudioContext {
  currentTime = 0;
  readonly destination = {} as AudioDestinationNode;

  /** 记录每次 createBufferSource 的调用,用来断言 lead-in 的调度方式 */
  readonly sources: FakeSource[] = [];
  readonly gainNode = { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };

  createGain(): GainNode {
    return this.gainNode as unknown as GainNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  /** 推进"硬件时钟"(秒) */
  advance(seconds: number): void {
    this.currentTime += seconds;
  }
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  playbackRate = { value: 1 };
  startedAt: number | null = null;
  startedOffset: number | null = null;
  stopped = false;

  connect(): void {}
  disconnect(): void {}
  start(when: number, offset: number): void {
    this.startedAt = when;
    this.startedOffset = offset;
  }
  stop(): void {
    this.stopped = true;
  }
}

function fakeBuffer(durationSec: number): AudioBuffer {
  return { duration: durationSec } as AudioBuffer;
}

function makeClock(options?: { muteBelowRate?: number }) {
  const ctx = new FakeAudioContext();
  const clock = new AudioClock(
    ctx as unknown as AudioContext,
    options ?? {},
  );
  return { ctx, clock };
}

describe('AudioClock 基本行为', () => {
  it('初始为 0,不运行', () => {
    const { clock } = makeClock();
    expect(clock.currentTime).toBe(0);
    expect(clock.isRunning).toBe(false);
    expect(clock.rate).toBe(1);
  });

  it('暂停时时间不流动 —— 哪怕硬件时钟在走', () => {
    const { ctx, clock } = makeClock();
    clock.seek(5000);
    ctx.advance(10);
    expect(clock.currentTime).toBe(5000);
  });

  it('无音频 buffer 时时钟照样自由运行', () => {
    const { ctx, clock } = makeClock();
    clock.play();
    ctx.advance(2);
    expect(clock.currentTime).toBeCloseTo(2000);
  });

  it('pause 把当前时间固化下来', () => {
    const { ctx, clock } = makeClock();
    clock.play();
    ctx.advance(1.5);
    clock.pause();
    ctx.advance(10);
    expect(clock.currentTime).toBeCloseTo(1500);
  });

  it('支持负时间(lead-in)', () => {
    const { ctx, clock } = makeClock();
    clock.seek(-2000);
    expect(clock.currentTime).toBe(-2000);

    clock.play();
    ctx.advance(0.5);
    expect(clock.currentTime).toBeCloseTo(-1500);
  });
});

describe('AudioClock 倍速', () => {
  // M0 验收标准 4:0.05× ~ 4× 均可用
  const RATES = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

  it.each(RATES)('%s× 下时间按倍速推进', (rate) => {
    const { ctx, clock } = makeClock();
    clock.setRate(rate);
    clock.play();
    ctx.advance(4);
    expect(clock.currentTime).toBeCloseTo(4000 * rate, 6);
  });

  it('播放中改倍速不会让时间跳变', () => {
    const { ctx, clock } = makeClock();
    clock.play();
    ctx.advance(2);
    const before = clock.currentTime;

    clock.setRate(4);
    expect(clock.currentTime).toBeCloseTo(before, 6);

    // 改倍速之后按新倍速走
    ctx.advance(1);
    expect(clock.currentTime).toBeCloseTo(before + 4000, 6);
  });

  it('暂停中改倍速不影响当前时间', () => {
    const { clock } = makeClock();
    clock.seek(3000);
    clock.setRate(0.05);
    expect(clock.currentTime).toBe(3000);
  });

  it('倍速 <= 0 抛错 —— 否则时间会倒流或冻死', () => {
    const { clock } = makeClock();
    expect(() => clock.setRate(0)).toThrow(RangeError);
    expect(() => clock.setRate(-1)).toThrow(RangeError);
  });

  it('低于阈值时静音(TECH-NOTES D3)', () => {
    const { ctx, clock } = makeClock({ muteBelowRate: 0.25 });
    clock.setBuffer(fakeBuffer(60));

    clock.setRate(0.1);
    clock.play();
    expect(ctx.gainNode.gain.value).toBe(0);

    clock.pause();
    clock.setRate(1);
    clock.play();
    expect(ctx.gainNode.gain.value).toBe(1);
  });
});

describe('AudioClock 的 seek', () => {
  it('暂停中 seek 直接改时间', () => {
    const { clock } = makeClock();
    clock.seek(1234);
    expect(clock.currentTime).toBe(1234);
  });

  it('播放中 seek 重设 anchor,之后继续正常推进', () => {
    const { ctx, clock } = makeClock();
    clock.play();
    ctx.advance(5);

    clock.seek(1000);
    expect(clock.currentTime).toBeCloseTo(1000);

    ctx.advance(1);
    expect(clock.currentTime).toBeCloseTo(2000);
  });

  it('反复 seek 到同一时刻结果恒等', () => {
    const { ctx, clock } = makeClock();
    clock.play();
    for (const t of [0, 5000, -1000, 99999, 5000, 0]) {
      clock.seek(t);
      expect(clock.currentTime).toBeCloseTo(t);
      ctx.advance(0); // 硬件时钟不动时不应有漂移
      expect(clock.currentTime).toBeCloseTo(t);
    }
  });
});

describe('AudioClock 的音频源调度', () => {
  it('正时间用 offset 启动', () => {
    const { ctx, clock } = makeClock();
    clock.setBuffer(fakeBuffer(60));
    clock.seek(3000);
    clock.play();

    const source = ctx.sources.at(-1)!;
    expect(source.startedOffset).toBeCloseTo(3); // 秒
    expect(source.startedAt).toBeCloseTo(ctx.currentTime);
  });

  it('负时间(lead-in)改用延迟启动,而不是负 offset', () => {
    const { ctx, clock } = makeClock();
    clock.setBuffer(fakeBuffer(60));
    clock.seek(-2000);
    clock.play();

    const source = ctx.sources.at(-1)!;
    // 负 offset 会抛错 —— 正确做法是把源调度到 2 秒后启动、offset 为 0
    expect(source.startedOffset).toBe(0);
    expect(source.startedAt).toBeCloseTo(ctx.currentTime + 2);
  });

  it('lead-in 的延迟要按倍速缩放', () => {
    const { ctx, clock } = makeClock();
    clock.setBuffer(fakeBuffer(60));
    clock.seek(-2000);
    clock.setRate(2);
    clock.play();

    // 谱面时间以 2× 推进,所以 2000ms 的 lead-in 只占 1 秒真实时间
    expect(ctx.sources.at(-1)!.startedAt).toBeCloseTo(ctx.currentTime + 1);
  });

  it('超过音频末尾时不建源,但时钟继续走', () => {
    const { ctx, clock } = makeClock();
    clock.setBuffer(fakeBuffer(10));
    clock.seek(20000);
    clock.play();

    expect(ctx.sources.length).toBe(0);
    ctx.advance(1);
    expect(clock.currentTime).toBeCloseTo(21000);
  });

  it('换 buffer 时保持当前时间与播放状态', () => {
    const { ctx, clock } = makeClock();
    clock.play();
    ctx.advance(3);

    clock.setBuffer(fakeBuffer(60));
    expect(clock.currentTime).toBeCloseTo(3000);
    expect(clock.isRunning).toBe(true);
  });
});
