import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadBeatmap } from '../load/beatmapLoader';
import { loadReplay } from '../load/replayLoader';
import { stateAt } from './query';
import { buildTimeline } from './timeline';
import type { ReplayTimeline } from './types';

/**
 * # 用真实谱面检验核心性能主张
 *
 * 架构文档说 `stateAt` 是 O(log n + k),因此"快进 / 快退 / 逐帧 / 倍速全部等价于
 * 对不同的 t 调用它"。这个主张只有在**真实数据**上跑够快才成立 ——
 * 60fps 意味着每帧预算 16.7ms,而 `stateAt` 只是其中一小部分。
 *
 * 这里的阈值刻意设得宽松(比实测慢一个数量级),目的是抓**退化**而不是卡性能:
 * 若哪天 `activeObjectsAt` 的回溯边界写错、退化成 O(n),这里会立刻红。
 *
 * ## 为什么回溯边界值得盯
 *
 * `activeObjectsAt` 向前回溯的范围由 `maxVisualDuration` 界定。实测真实谱面里
 * 这个值可以很大:`stable.osu` 有一条 **6557ms** 的长滑条(distance 1020,低 SV),
 * `lazer-moonlight.osu` 的收尾转盘长 **9754ms**。也就是说回溯窗口约 10 秒,
 * 密集图上一帧要扫过几十到几百个物件 —— 仍是常数级(k 有界),但不是"几个"。
 */

const FIXTURE_DIR = join(process.cwd(), 'fixtures');

interface Loaded {
  readonly name: string;
  readonly timeline: ReplayTimeline;
}

const NAMES = ['stable', 'stable-hdfl', 'lazer', 'lazer-moonlight'] as const;

function available(): string[] {
  return NAMES.filter(
    (n) =>
      existsSync(join(FIXTURE_DIR, `${n}.osu`)) && existsSync(join(FIXTURE_DIR, `${n}.osr`)),
  );
}

const AVAILABLE = available();

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function load(name: string): Promise<Loaded> {
  const [beatmap, replay] = await Promise.all([
    loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`))),
    loadReplay(read(join(FIXTURE_DIR, `${name}.osr`))),
  ]);
  return { name, timeline: buildTimeline(beatmap.beatmap, replay.frames) };
}

/** 均匀采样整条时间轴,返回每次调用的平均耗时(ms)。 */
function measure(timeline: ReplayTimeline, samples: number): number {
  const { startTime, endTime } = timeline;
  const span = endTime - startTime;

  // 预热,让 JIT 稳定下来
  for (let i = 0; i < 2000; i++) stateAt(timeline, startTime + span * (i / 2000));

  const t0 = performance.now();
  for (let i = 0; i < samples; i++) stateAt(timeline, startTime + span * (i / samples));
  return (performance.now() - t0) / samples;
}

describe.skipIf(AVAILABLE.length === 0)('stateAt 在真实谱面上的性能', () => {
  for (const name of AVAILABLE) {
    describe(name, () => {
      it('构建时间线在 200ms 内 —— 加载时一次性成本', async () => {
        const [beatmap, replay] = await Promise.all([
          loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`))),
          loadReplay(read(join(FIXTURE_DIR, `${name}.osr`))),
        ]);

        const t0 = performance.now();
        buildTimeline(beatmap.beatmap, replay.frames);
        const elapsed = performance.now() - t0;

        expect(elapsed, `buildTimeline 耗时 ${elapsed.toFixed(1)}ms`).toBeLessThan(200);
      });

      it('单次 stateAt 远低于一帧预算(阈值 1ms,实测应在 μs 量级)', async () => {
        const { timeline } = await load(name);
        const per = measure(timeline, 20000);

        expect(per, `每次 ${(per * 1000).toFixed(1)}μs`).toBeLessThan(1);
      });

      it('活跃物件数有界 —— 回溯没有退化成全表扫描', async () => {
        const { timeline } = await load(name);
        const { startTime, endTime } = timeline;
        const span = endTime - startTime;

        let max = 0;
        for (let i = 0; i < 5000; i++) {
          const n = stateAt(timeline, startTime + span * (i / 5000)).activeObjects.length;
          if (n > max) max = n;
        }

        // 任意时刻同屏物件数应远小于物件总数。真实谱面实测个位数~十几个。
        expect(max).toBeGreaterThan(0);
        expect(max, `同屏最多 ${max} 个物件`).toBeLessThan(64);
        expect(max).toBeLessThan(timeline.beatmap.hitObjects.length / 4);
      });

      it('随机 seek 与顺序播放同样快 —— 无隐藏的顺序依赖', async () => {
        const { timeline } = await load(name);
        const { startTime, endTime } = timeline;
        const span = endTime - startTime;

        const sequential = measure(timeline, 10000);

        let seed = 20260823;
        const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const times = Array.from({ length: 10000 }, () => startTime + span * rnd());

        for (let i = 0; i < 2000; i++) stateAt(timeline, times[i]!);
        const t0 = performance.now();
        for (const t of times) stateAt(timeline, t);
        const random = (performance.now() - t0) / times.length;

        // 若实现里藏了"从上一帧继续扫"的优化,随机访问会显著变慢
        expect(random, `顺序 ${(sequential * 1000).toFixed(1)}μs vs 随机 ${(random * 1000).toFixed(1)}μs`)
          .toBeLessThan(Math.max(sequential * 8, 0.5));
      });
    });
  }
});
