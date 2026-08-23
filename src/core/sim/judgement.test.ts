import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { countByKind, loadBeatmap } from '../load/beatmapLoader';
import { loadReplay } from '../load/replayLoader';
import { createCircleJudgement, extractPresses, resultForOffset, canStillBeHit } from './judgement';
import { hitWindowsFromOD } from './difficulty';
import { buildReplayFrames } from '../replay/frames';
import { buildTimeline } from './timeline';
import { HitResult, type SimBeatmap, type SimHitObject } from './types';

/* ---------------- 纯函数部分 ---------------- */

const OD8 = hitWindowsFromOD(8); // great 31.5 / ok 75.5 / meh 119.5 / miss 400

describe('resultForOffset', () => {
  it('OD 8 的四档边界', () => {
    expect(resultForOffset(0, OD8)).toBe(HitResult.Great);
    expect(resultForOffset(31, OD8)).toBe(HitResult.Great);
    expect(resultForOffset(32, OD8)).toBe(HitResult.Ok);
    expect(resultForOffset(75, OD8)).toBe(HitResult.Ok);
    expect(resultForOffset(76, OD8)).toBe(HitResult.Meh);
    expect(resultForOffset(119, OD8)).toBe(HitResult.Meh);
    expect(resultForOffset(120, OD8)).toBe(HitResult.Miss);
    expect(resultForOffset(400, OD8)).toBe(HitResult.Miss);
  });

  it('超过 miss 窗口返回 None(无判定,不是 Miss)', () => {
    expect(resultForOffset(401, OD8)).toBe(HitResult.None);
    expect(resultForOffset(1e9, OD8)).toBe(HitResult.None);
  });

  it('先取绝对值 —— 提早与过晚对称', () => {
    for (const d of [5, 31, 32, 76, 120, 399, 401]) {
      expect(resultForOffset(-d, OD8), `-${d}`).toBe(resultForOffset(d, OD8));
    }
  });

  it('比较是 <= —— 恰好等于窗口值算命中', () => {
    expect(resultForOffset(OD8.great, OD8)).toBe(HitResult.Great);
    expect(resultForOffset(OD8.great + 0.001, OD8)).toBe(HitResult.Ok);
  });
});

describe('canStillBeHit', () => {
  it('阈值是 meh 窗口,不是 miss 窗口', () => {
    expect(canStillBeHit(OD8.meh, OD8)).toBe(true);
    expect(canStillBeHit(OD8.meh + 0.001, OD8)).toBe(false);
    // 400 远超 meh,所以早就过期了 —— 这条锁住"阈值不是 400"
    expect(canStillBeHit(200, OD8)).toBe(false);
  });

  it('不取绝对值 —— 提早任意多都不算过期', () => {
    expect(canStillBeHit(-1e9, OD8)).toBe(true);
    expect(canStillBeHit(-OD8.miss, OD8)).toBe(true);
  });
});

describe('extractPresses', () => {
  const frames = (specs: readonly (readonly [number, number])[]) =>
    buildReplayFrames(specs.map(([startTime, keys]) => ({ startTime, x: 0, y: 0, keys })));

  it('只取按下的边沿,不取持续按住', () => {
    // 1=M1。按下 → 保持 → 保持 → 松开 → 再按下
    const p = extractPresses(frames([[0, 0], [100, 1], [200, 1], [300, 0], [400, 1]]));
    expect(p.map((x) => x.time)).toEqual([100, 400]);
  });

  it('K1 与 M1 视为同一个键(规范化后)', () => {
    // 4=K1 → 规范化成 M1(1)。1 后接 4 不算新按下
    const p = extractPresses(frames([[0, 1], [100, 4]]));
    expect(p.length).toBe(1);
    expect(p[0]!.time).toBe(0);
  });

  it('同一帧两个键同时新按下 → 两次 press', () => {
    const p = extractPresses(frames([[0, 0], [100, 1 | 2]]));
    expect(p.length).toBe(2);
    expect(p.every((x) => x.time === 100)).toBe(true);
  });

  it('第二个键后按下时单独算一次', () => {
    const p = extractPresses(frames([[0, 1], [100, 1 | 2]]));
    expect(p.map((x) => x.time)).toEqual([0, 100]);
  });

  it('用帧自身坐标,不插值', () => {
    const f = buildReplayFrames([
      { startTime: 0, x: 0, y: 0, keys: 0 },
      { startTime: 100, x: 123, y: 456, keys: 1 },
    ]);
    expect(extractPresses(f)[0]).toMatchObject({ time: 100, x: 123, y: 456 });
  });

  it('Smoke 键不算 press', () => {
    expect(extractPresses(frames([[0, 0], [100, 16]]))).toEqual([]);
  });
});

/* ---------------- 合成场景 ---------------- */

function circle(startTime: number, x = 256, y = 192): SimHitObject {
  return {
    kind: 'circle',
    startTime,
    endTime: startTime,
    x, y,
    endX: x, endY: y,
    stackHeight: 0,
    stackedX: x, stackedY: y,
    spans: 1,
    newCombo: false,
    comboIndex: 0,
    indexInCombo: 1,
  };
}

function beatmapOf(hitObjects: readonly SimHitObject[], od = 8, cs = 4): SimBeatmap {
  return {
    hitObjects,
    breaks: [],
    difficulty: {
      circleSize: cs,
      approachRate: 9,
      overallDifficulty: od,
      drainRate: 5,
      sliderMultiplier: 1.4,
      sliderTickRate: 1,
    },
    audioLeadIn: 0,
    stackLeniency: 0.7,
  };
}

/** 在 t 时刻于 (x,y) 点一下,前后各补一帧未按下。 */
function tapAt(taps: readonly (readonly [number, number, number])[]) {
  const raw: { startTime: number; x: number; y: number; keys: number }[] = [];
  for (const [t, x, y] of taps) {
    raw.push({ startTime: t - 1, x, y, keys: 0 });
    raw.push({ startTime: t, x, y, keys: 1 });
    raw.push({ startTime: t + 1, x, y, keys: 0 });
  }
  return buildReplayFrames(raw);
}

function judge(beatmap: SimBeatmap, frames: ReturnType<typeof buildReplayFrames>) {
  const timeline = buildTimeline(beatmap, frames, { judge: createCircleJudgement() });
  return {
    timeline,
    results: timeline.objectResults.map((r) => r?.result ?? HitResult.None),
    last: timeline.events.at(-1)?.cum,
  };
}

describe('circle 判定 —— 合成场景', () => {
  it('正中命中得 300', () => {
    const { results } = judge(beatmapOf([circle(1000)]), tapAt([[1000, 256, 192]]));
    expect(results).toEqual([HitResult.Great]);
  });

  it('偏差落在各档窗口内得对应判定', () => {
    for (const [delta, expected] of [
      [31, HitResult.Great],
      [32, HitResult.Ok],
      [76, HitResult.Meh],
      [120, HitResult.Miss],
    ] as const) {
      const { results } = judge(beatmapOf([circle(1000)]), tapAt([[1000 + delta, 256, 192]]));
      expect(results, `delta=${delta}`).toEqual([expected]);
    }
  });

  it('光标在圈外 → 不判定,物件最终 miss', () => {
    const { results } = judge(beatmapOf([circle(1000)]), tapAt([[1000, 256 + 100, 192]]));
    expect(results).toEqual([HitResult.Miss]);
  });

  it('完全不点 → miss', () => {
    const { results } = judge(beatmapOf([circle(1000)]), buildReplayFrames([
      { startTime: 0, x: 256, y: 192, keys: 0 },
      { startTime: 5000, x: 256, y: 192, keys: 0 },
    ]));
    expect(results).toEqual([HitResult.Miss]);
  });

  it('过晚超出 meh 窗口后点击 → 该物件已过期,点击落空', () => {
    // meh 窗口 119.5,在 200ms 时点已经太晚 —— 物件在 1119.5 就过期了
    const { results, timeline } = judge(
      beatmapOf([circle(1000)]),
      tapAt([[1200, 256, 192]]),
    );
    expect(results).toEqual([HitResult.Miss]);
    // miss 发生在过期时刻,不是点击时刻
    expect(timeline.events[0]!.time).toBeCloseTo(1000 + 119.5, 6);
  });

  it('提早很多点击仍会消耗物件并判 Miss(stable 的"点早了吃 miss")', () => {
    // 提早 200ms:超出 meh 但在 400 内 → ResultFor 给 Miss,消耗物件
    const { results, timeline } = judge(
      beatmapOf([circle(1000)]),
      tapAt([[800, 256, 192]]),
    );
    expect(results).toEqual([HitResult.Miss]);
    // 这次 miss 发生在**点击时刻**,而不是过期时刻 —— 与上一条对照
    expect(timeline.events[0]!.time).toBe(800);
  });

  it('提早超过 400ms 点击 → 无判定,物件之后正常过期', () => {
    const { timeline } = judge(beatmapOf([circle(1000)]), tapAt([[500, 256, 192]]));
    expect(timeline.events.length).toBe(1);
    expect(timeline.events[0]!.time).toBeCloseTo(1119.5, 6);
  });

  it('一次按下最多判定一个物件', () => {
    // 两个圈同时同位置,只点一次 → 一个 300 一个 miss
    const { results } = judge(
      beatmapOf([circle(1000), circle(1000)]),
      tapAt([[1000, 256, 192]]),
    );
    expect(results.filter((r) => r === HitResult.Great).length).toBe(1);
    expect(results.filter((r) => r === HitResult.Miss).length).toBe(1);
  });

  it('两次按下判定两个物件', () => {
    const { results } = judge(
      beatmapOf([circle(1000), circle(1100)]),
      tapAt([[1000, 256, 192], [1100, 256, 192]]),
    );
    expect(results).toEqual([HitResult.Great, HitResult.Great]);
  });

  it('CS 影响命中半径', () => {
    // CS 4 半径约 36.5;CS 0 约 54.4。在 45 单位处点击:CS 0 命中,CS 4 不中
    const at45: readonly (readonly [number, number, number])[] = [[1000, 256 + 45, 192]];
    expect(judge(beatmapOf([circle(1000)], 8, 4), tapAt(at45)).results)
      .toEqual([HitResult.Miss]);
    expect(judge(beatmapOf([circle(1000)], 8, 0), tapAt(at45)).results)
      .toEqual([HitResult.Great]);
  });
});

describe('notelock', () => {
  it('未判定的早物件阻挡后物件', () => {
    // 圈 A 在 1000,圈 B 在 2000(相距远超 3ms 宽容)。只在 2000 点一次:
    // A 此时已过期变 miss,B 应该能命中
    const { results } = judge(
      beatmapOf([circle(1000, 100, 100), circle(2000, 400, 300)]),
      tapAt([[2000, 400, 300]]),
    );
    expect(results).toEqual([HitResult.Miss, HitResult.Great]);
  });

  it('在早物件仍可命中时点后物件 → 被 notelock 挡住', () => {
    // A 在 1000,B 在 1050(相距 50ms > 3ms 宽容,所以 A 阻挡 B)。
    // 在 1050 于 B 的位置点一次:A 未判定且 endTime+3 < B.startTime → 挡住
    const { results } = judge(
      beatmapOf([circle(1000, 100, 100), circle(1050, 400, 300)]),
      tapAt([[1050, 400, 300]]),
    );
    // B 没被判定(被挡),两者最终都 miss
    expect(results).toEqual([HitResult.Miss, HitResult.Miss]);
  });

  it('3ms 宽容内的物件不互锁 —— 可乱序命中', () => {
    // A 在 1000,B 在 1002(差 2ms < 3ms)。在 1002 点 B 的位置 → 不该被挡
    const { results } = judge(
      beatmapOf([circle(1000, 100, 100), circle(1002, 400, 300)]),
      tapAt([[1002, 400, 300]]),
    );
    expect(results[1]).toBe(HitResult.Great);
  });
});

/* ---------------- 真实回放 ---------------- */

const FIXTURE_DIR = join(process.cwd(), 'fixtures');
const NAMES = ['stable', 'stable-hdfl', 'lazer', 'lazer-moonlight'];
const AVAILABLE = NAMES.filter(
  (n) => existsSync(join(FIXTURE_DIR, `${n}.osu`)) && existsSync(join(FIXTURE_DIR, `${n}.osr`)),
);

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe.skipIf(AVAILABLE.length === 0)('真实回放上的 circle 判定', () => {
  for (const name of AVAILABLE) {
    describe(name, () => {
      const load = async () => {
        const [bm, rp] = await Promise.all([
          loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`))),
          loadReplay(read(join(FIXTURE_DIR, `${name}.osr`))),
        ]);
        const timeline = buildTimeline(bm.beatmap, rp.frames, {
          judge: createCircleJudgement(),
        });
        return { bm, rp, timeline };
      };

      it('每个 circle 与每条滑条都得到了判定,没有漏判', async () => {
        const { bm, timeline } = await load();

        bm.beatmap.hitObjects.forEach((o, i) => {
          if (o.kind === 'spinner') return;
          expect(timeline.objectResults[i], `${o.kind} @${o.startTime} 未判定`).not.toBeNull();
        });
      });

      it('转盘不产生判定(转盘是转的,不吃按下)', async () => {
        const { bm, timeline } = await load();

        bm.beatmap.hitObjects.forEach((o, i) => {
          if (o.kind !== 'spinner') return;
          expect(timeline.objectResults[i], `spinner @${o.startTime}`).toBeNull();
        });
      });

      it('判定数 == circle 数 + 滑条数', async () => {
        const { bm, timeline } = await load();
        const counts = countByKind(bm.beatmap);
        expect(timeline.events.length).toBe(counts.circle + counts.slider);
      });

      it('circle 判定标 part=circle,滑条头标 part=sliderHead', async () => {
        const { bm, timeline } = await load();

        for (const e of timeline.events) {
          const kind = bm.beatmap.hitObjects[e.objectIndex]!.kind;
          expect(e.part, `#${e.objectIndex} ${kind}`).toBe(
            kind === 'slider' ? 'sliderHead' : 'circle',
          );
        }
      });

      it('事件按时间升序', async () => {
        const { timeline } = await load();
        for (let i = 1; i < timeline.events.length; i++) {
          expect(timeline.events[i]!.time).toBeGreaterThanOrEqual(timeline.events[i - 1]!.time);
        }
      });

      /**
       * # A2 的核心判据
       *
       * `.osr` 头部的 `countMiss` 是**全图** miss 数(含滑条与转盘),所以它是
       * 我们判出的 circle miss 数的**上界** —— circle miss 不可能多于全图 miss。
       *
       * 这条断言抓出过两个真 bug:
       * 1. 完全跳过滑条时,给滑条头的按下漏到后面的 circle 上把它判成 Miss
       * 2. 滑条在"头命中"时就被当作判定完成,导致滑动过程中的按下又漏出去
       *
       * 两次都是在 FC 回放(全图 0 miss)上判出了 miss —— 那是铁证。
       */
      it('circle 的 miss 数不超过 .osr 全图 miss 数', async () => {
        const { bm, rp, timeline } = await load();

        const circleMisses = timeline.events.filter(
          (e) => e.part === 'circle' && e.result === HitResult.Miss,
        ).length;

        expect(
          circleMisses,
          `circle miss ${circleMisses} > 全图 miss ${rp.info.countMiss}` +
            `(谱面 ${countByKind(bm.beatmap).circle} 个 circle)`,
        ).toBeLessThanOrEqual(rp.info.countMiss);
      });

      /**
       * 滑条头 miss 只做**宽松**上界,不能照搬 circle 那条判据。
       *
       * 原因:stable 里漏掉滑条头但滑过刻度与尾,整条滑条仍会按"命中了多少部件"
       * 给出 100 或 50,**不是 miss**。所以滑条头 miss 数可以合法地超过
       * `.osr` 的全图 miss 数 —— 实测 `stable-hdfl` 就是 4 > 3。
       *
       * 这里只抓"判定完全失灵"(大批滑条头判漏),不卡精度。
       */
      it('滑条头 miss 只占少数', async () => {
        const { timeline } = await load();

        const heads = timeline.events.filter((e) => e.part === 'sliderHead');
        const headMisses = heads.filter((e) => e.result === HitResult.Miss).length;

        expect(headMisses / heads.length,
          `滑条头 miss 率 ${(headMisses / heads.length * 100).toFixed(1)}%`)
          .toBeLessThan(0.1);
      });

      it('累积计数只算 circle,不算滑条头', async () => {
        const { timeline } = await load();
        const cum = timeline.events.at(-1)!.cum;

        const circleEvents = timeline.events.filter((e) => e.part === 'circle');
        expect(cum.countGreat + cum.countOk + cum.countMeh + cum.countMiss)
          .toBe(circleEvents.length);
      });

      it('maxCombo 不超过 .osr 的 maxCombo —— 我们缺滑条刻度,必然偏小或相等', async () => {
        const { rp, timeline } = await load();
        const cum = timeline.events.at(-1)!.cum;

        expect(cum.maxCombo).toBeLessThanOrEqual(rp.info.maxCombo);
      });

      it('命中率显著高于随机 —— 判定确实在工作', async () => {
        const { timeline } = await load();
        const hits = timeline.events.filter((e) => e.result !== HitResult.Miss).length;

        expect(hits / timeline.events.length,
          `命中率 ${(hits / timeline.events.length * 100).toFixed(1)}%`)
          .toBeGreaterThan(0.9);
      });
    });
  }
});
