import { describe, expect, it } from 'vitest';

import { AudioClock } from './AudioClock';

/**
 * 假的 `AudioParam`。
 *
 * 刻意**记录每次调度事件**,而不只是存一个值 —— 因为音量的关键质量点是
 * "有没有走斜坡"。若只存值,把 `linearRampToValueAtTime` 写成 `value = x`
 * 也照样通过测试,而那正是会爆音的写法。
 */
class FakeAudioParam {
  value = 1;

  readonly events: {
    readonly kind: 'cancel' | 'setValueAtTime' | 'linearRamp';
    readonly value?: number;
    readonly time: number;
  }[] = [];

  cancelScheduledValues(time: number): void {
    this.events.push({ kind: 'cancel', time });
  }

  setValueAtTime(value: number, time: number): void {
    this.events.push({ kind: 'setValueAtTime', value, time });
    this.value = value;
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ kind: 'linearRamp', value, time });
    // 真实实现是逐采样过渡;测试里直接落到终值,便于断言最终结果
    this.value = value;
  }

  /** 最近一次斜坡的目标值与时长。没有斜坡则返回 null。 */
  lastRamp(): { readonly target: number; readonly duration: number } | null {
    const ramp = [...this.events].reverse().find((e) => e.kind === 'linearRamp');
    if (!ramp) return null;

    const start = [...this.events]
      .reverse()
      .find((e) => e.kind === 'setValueAtTime' && e.time <= ramp.time);

    return { target: ramp.value ?? 0, duration: ramp.time - (start?.time ?? ramp.time) };
  }

  reset(): void {
    this.events.length = 0;
  }
}

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
  readonly gainParam = new FakeAudioParam();
  readonly gainNode = {
    gain: this.gainParam,
    connect: () => {},
    disconnect: () => {},
  };

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

function makeClock(options?: { muteBelowRate?: number; initialVolume?: number }) {
  const ctx = new FakeAudioContext();
  const clock = new AudioClock(ctx as unknown as AudioContext, options ?? {});
  // 构造时的赋值不算用户操作,清掉便于后续断言
  ctx.gainParam.reset();
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
    const { clock } = makeClock({ muteBelowRate: 0.25 });
    clock.setBuffer(fakeBuffer(60));

    clock.setRate(0.1);
    clock.play();
    expect(clock.effectiveVolume).toBe(0);

    clock.pause();
    clock.setRate(1);
    clock.play();
    expect(clock.effectiveVolume).toBe(1);
  });

  it('低倍速静音在**暂停时**也立即生效 —— 不必等下次 play', () => {
    // 这条防的是"只在 startSource 里设增益"那种写法:暂停时改倍速,
    // effectiveVolume 会是过期值
    const { clock } = makeClock({ muteBelowRate: 0.25 });
    clock.setBuffer(fakeBuffer(60));

    expect(clock.effectiveVolume).toBe(1);
    clock.setRate(0.1);
    expect(clock.effectiveVolume).toBe(0);
  });
});

describe('AudioClock 音量', () => {
  it('默认满音量', () => {
    const { clock } = makeClock();
    expect(clock.volume).toBe(1);
    expect(clock.muted).toBe(false);
    expect(clock.effectiveVolume).toBe(1);
  });

  it('initialVolume 生效', () => {
    const { clock } = makeClock({ initialVolume: 0.5 });
    expect(clock.volume).toBe(0.5);
    // 感知 0.5 → 线性 0.25
    expect(clock.effectiveVolume).toBeCloseTo(0.25, 10);
  });

  it('感知音量平方后作为线性增益', () => {
    // 人耳对声压近似对数,滑块位置直接当增益会觉得"前半段几乎没变化"。
    // 这条把平方这个约定钉住 —— 改成线性会让这条红。
    const { clock } = makeClock();
    for (const [perceptual, linear] of [
      [0, 0],
      [0.25, 0.0625],
      [0.5, 0.25],
      [0.75, 0.5625],
      [1, 1],
    ] as const) {
      clock.setVolume(perceptual);
      expect(clock.effectiveVolume, `感知 ${perceptual}`).toBeCloseTo(linear, 10);
    }
  });

  it('钳制到 0..1', () => {
    const { clock } = makeClock();
    clock.setVolume(-5);
    expect(clock.volume).toBe(0);
    clock.setVolume(99);
    expect(clock.volume).toBe(1);
  });

  it('非有限值一律归 0 —— 静音比突然满音量安全', () => {
    // NaN / ±Infinity 都归 0。若某处算出了 Infinity,炸耳朵是最坏的失败方式
    const { clock } = makeClock();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      clock.setVolume(1);
      clock.setVolume(bad);
      expect(clock.volume, String(bad)).toBe(0);
    }
  });

  it('静音不改 volume —— 取消静音后回到原音量', () => {
    const { clock } = makeClock();
    clock.setVolume(0.6);

    clock.setMuted(true);
    expect(clock.volume).toBe(0.6);
    expect(clock.effectiveVolume).toBe(0);

    clock.setMuted(false);
    expect(clock.effectiveVolume).toBeCloseTo(0.36, 10);
  });

  it('toggleMuted 来回切换', () => {
    const { clock } = makeClock();
    clock.toggleMuted();
    expect(clock.muted).toBe(true);
    clock.toggleMuted();
    expect(clock.muted).toBe(false);
  });

  it('静音时改音量,取消静音后用的是新音量', () => {
    const { clock } = makeClock();
    clock.setMuted(true);
    clock.setVolume(0.5);
    expect(clock.effectiveVolume).toBe(0);

    clock.setMuted(false);
    expect(clock.effectiveVolume).toBeCloseTo(0.25, 10);
  });

  /* ---- 下面几条是"不爆音"的质量保证 ---- */

  it('**走斜坡而不是硬跳** —— 直接赋值 gain.value 会爆音', () => {
    const { ctx, clock } = makeClock();
    ctx.gainParam.reset();

    clock.setVolume(0.5);

    const kinds = ctx.gainParam.events.map((e) => e.kind);
    // 三步缺一不可,见 rampGain 的注释
    expect(kinds).toEqual(['cancel', 'setValueAtTime', 'linearRamp']);
  });

  it('斜坡时长约 15ms', () => {
    const { ctx, clock } = makeClock();
    ctx.gainParam.reset();

    clock.setVolume(0.3);

    const ramp = ctx.gainParam.lastRamp();
    expect(ramp).not.toBeNull();
    expect(ramp!.duration).toBeCloseTo(0.015, 6);
    expect(ramp!.target).toBeCloseTo(0.09, 10);
  });

  it('连续快速调节不会叠加出乱曲线 —— 每次都先 cancel', () => {
    const { ctx, clock } = makeClock();
    ctx.gainParam.reset();

    for (const v of [0.1, 0.4, 0.7, 0.2]) clock.setVolume(v);

    const cancels = ctx.gainParam.events.filter((e) => e.kind === 'cancel').length;
    const ramps = ctx.gainParam.events.filter((e) => e.kind === 'linearRamp').length;
    expect(cancels).toBe(4);
    expect(ramps).toBe(4);
  });

  it('斜坡起点是当前值 —— 省掉这步快速拖动会"追不上"', () => {
    const { ctx, clock } = makeClock();
    clock.setVolume(0.8); // 线性 0.64
    ctx.gainParam.reset();

    clock.setVolume(0.2);

    const setStart = ctx.gainParam.events.find((e) => e.kind === 'setValueAtTime');
    expect(setStart?.value).toBeCloseTo(0.64, 10);
  });

  it('播放中改音量不会被下一次 restartAt 冲掉', () => {
    // 这条防的是"在 startSource 里赋值增益"那种写法:seek / 改倍速都会
    // 触发 restartAt,用户刚调的音量就没了
    const { ctx, clock } = makeClock();
    clock.setBuffer(fakeBuffer(60));
    clock.play();

    clock.setVolume(0.5);
    expect(clock.effectiveVolume).toBeCloseTo(0.25, 10);

    clock.seek(3000); // 内部会 restartAt
    expect(clock.effectiveVolume).toBeCloseTo(0.25, 10);
    expect(ctx.gainParam.value).toBeCloseTo(0.25, 10);
  });

  it('音量与倍速静音同时生效时取 0', () => {
    const { clock } = makeClock({ muteBelowRate: 0.25 });
    clock.setVolume(0.9);
    clock.setRate(0.1);
    expect(clock.effectiveVolume).toBe(0);

    // 倍速回来后音量恢复
    clock.setRate(1);
    expect(clock.effectiveVolume).toBeCloseTo(0.81, 10);
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
