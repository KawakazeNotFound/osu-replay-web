import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadBeatmap } from '../load/beatmapLoader';
import { OBJECT_RADIUS, preemptFromAR, radiusFromCS } from './difficulty';
import {
  STACK_DISTANCE,
  STACK_OFFSET_FACTOR,
  computeStackHeights,
  stackOffset,
  type StackableObject,
} from './stacking';
import type { HitObjectKind } from './types';

/**
 * 期望值一律**按 lazer 算法手推**,不从本实现反推。
 * 算法来源与"不要顺手简化"的几条见 `stacking.ts` 顶部注释。
 */

function obj(
  startTime: number,
  x: number,
  y: number,
  kind: HitObjectKind = 'circle',
  endTime = startTime,
  endX = x,
  endY = y,
): StackableObject {
  return { kind, startTime, endTime, x, y, endX, endY };
}

/** AR 9 → preempt 600。stackLeniency 0.7 → 阈值 420ms。 */
const AR9 = { stackLeniency: 0.7, timePreempt: preemptFromAR(9), fileFormat: 14 };

function heights(objects: readonly StackableObject[], options = AR9): number[] {
  return Array.from(computeStackHeights(objects, options));
}

describe('computeStackHeights —— 基本情形', () => {
  it('空输入返回空', () => {
    expect(heights([])).toEqual([]);
  });

  it('单个物件不堆叠', () => {
    expect(heights([obj(1000, 100, 100)])).toEqual([0]);
  });

  it('位置相同、时间相近的两个圈 → 前一个叠高一层', () => {
    // 倒序处理:i=1 是后一个圈,往回找到 i=0 位置相同 → heights[0] = heights[1] + 1 = 1
    expect(heights([obj(1000, 100, 100), obj(1100, 100, 100)])).toEqual([1, 0]);
  });

  it('三个同位置的圈 → 链式堆叠 2/1/0', () => {
    // 这条验证 objectIndex 在内层循环里被重新指向(链式)的行为
    expect(
      heights([obj(1000, 100, 100), obj(1100, 100, 100), obj(1200, 100, 100)]),
    ).toEqual([2, 1, 0]);
  });

  it('位置相隔超过 STACK_DISTANCE 时不堆叠', () => {
    expect(heights([obj(1000, 100, 100), obj(1100, 100 + STACK_DISTANCE + 1, 100)]))
      .toEqual([0, 0]);
  });

  it('距离恰好等于 STACK_DISTANCE 时**不**堆叠 —— 判据是严格小于', () => {
    expect(heights([obj(1000, 100, 100), obj(1100, 100 + STACK_DISTANCE, 100)]))
      .toEqual([0, 0]);
  });

  it('距离略小于 STACK_DISTANCE 时堆叠', () => {
    expect(heights([obj(1000, 100, 100), obj(1100, 100 + STACK_DISTANCE - 0.01, 100)]))
      .toEqual([1, 0]);
  });

  it('时间间隔超过阈值时不堆叠', () => {
    // 阈值 = trunc(600) * 0.7 = 420ms
    expect(heights([obj(1000, 100, 100), obj(1000 + 421, 100, 100)])).toEqual([0, 0]);
    expect(heights([obj(1000, 100, 100), obj(1000 + 420, 100, 100)])).toEqual([1, 0]);
  });

  it('转盘被跳过,不参与堆叠也不打断链', () => {
    const result = heights([
      obj(1000, 100, 100),
      obj(1050, 256, 192, 'spinner', 1500),
      obj(1200, 100, 100),
    ]);
    // 转盘自身恒为 0;两侧的圈仍然叠上(转盘是 continue 而非 break)
    expect(result[1]).toBe(0);
    expect(result).toEqual([1, 0, 0]);
  });
});

describe('computeStackHeights —— 截断行为', () => {
  it('阈值只截断 preempt,不截断乘积', () => {
    // preempt 577(AR 9.15 截断后)× 0.7 = 403.9,**不**再取整
    const options = { stackLeniency: 0.7, timePreempt: preemptFromAR(9.15), fileFormat: 14 };
    expect(options.timePreempt).toBe(577);

    // 间隔 403 < 403.9 → 堆叠;404 > 403.9 → 不堆叠
    expect(heights([obj(1000, 100, 100), obj(1403, 100, 100)], options)).toEqual([1, 0]);
    expect(heights([obj(1000, 100, 100), obj(1404, 100, 100)], options)).toEqual([0, 0]);
  });

  it('circle 分支的时间比较对两个操作数各自截断', () => {
    // 阈值 420。若不截断:1420.9 - 1000.5 = 420.4 <= 420?不,420.4 > 420 → 不堆叠
    // 截断后:  trunc(1420.9) - trunc(1000.5) = 1420 - 1000 = 420,不 > 420 → **堆叠**
    // 两种实现结论相反,正好卡住这个截断点。
    expect(heights([obj(1000.5, 100, 100), obj(1420.9, 100, 100)])).toEqual([1, 0]);
  });

  it('slider 分支的时间比较**不**截断,且比的是 start-vs-start', () => {
    // slider 在后、圈在前。slider 分支用 objectI.startTime - objectN.startTime,
    // 不截断:1420.9 - 1000.5 = 420.4 > 420 → 不堆叠。
    // 若误用了 circle 分支的截断规则,会得到 420 → 堆叠。
    const sliderLast = [
      obj(1000.5, 100, 100),
      obj(1420.9, 100, 100, 'slider', 1600, 100, 100),
    ];
    expect(heights(sliderLast)).toEqual([0, 0]);
  });
});

describe('computeStackHeights —— 滑条尾的负向堆叠', () => {
  it('圈落在滑条尾上 → 负向偏移(往右下)', () => {
    // 滑条从 (100,100) 走到 (200,200);圈落在滑条**尾**上
    const result = heights([
      obj(1000, 100, 100, 'slider', 1200, 200, 200),
      obj(1300, 200, 200),
    ]);

    // lazer:offset = heights[i] - heights[n] + 1 = 0 - 0 + 1 = 1,
    // 然后 n+1..i 中位于滑条尾处的物件 stackHeight -= offset → -1
    expect(result[1]).toBe(-1);
    expect(result[0]).toBe(0);
  });

  it('负向堆叠会把整串同处物件一起下推', () => {
    const result = heights([
      obj(1000, 100, 100, 'slider', 1200, 200, 200),
      obj(1250, 200, 200),
      obj(1300, 200, 200),
    ]);

    // 先处理 i=2:与 i=1 位置相同 → heights[1] = 1
    // 再处理 i=1(已非 0,跳过);处理到滑条时把 n+1..i 中同处的一起 -= offset
    // 具体数值按算法推演,这里断言"两者都被下推且相对关系保持"
    expect(result[0]).toBe(0);
    expect(result[1]).toBeLessThan(0);
    expect(result[2]).toBeLessThan(result[1]);
  });

  it('滑条在后、圈在前 → 正向堆叠(slider 分支恒为正)', () => {
    // lazer 注释:从第一个滑条起 "ALWAYS stack positive regardless"
    const result = heights([
      obj(1000, 200, 200),
      obj(1300, 200, 200, 'slider', 1500, 300, 300),
    ]);
    expect(result[0]).toBeGreaterThan(0);
    expect(result[1]).toBe(0);
  });
});

describe('stackOffset', () => {
  it('偏移 = stackHeight * scale * -6.4', () => {
    const scale = radiusFromCS(4) / OBJECT_RADIUS;
    expect(stackOffset(3, scale)).toBeCloseTo(3 * scale * STACK_OFFSET_FACTOR, 10);
  });

  it('0 层无偏移', () => {
    expect(stackOffset(0, 0.5)).toBe(0);
  });

  it('正层数往左上(负偏移),负层数往右下(正偏移)', () => {
    expect(stackOffset(2, 0.5)).toBeLessThan(0);
    expect(stackOffset(-2, 0.5)).toBeGreaterThan(0);
  });
});

describe('legacy 格式', () => {
  it('fileFormat < 6 抛出明确错误而不是静默不堆叠', () => {
    expect(() =>
      computeStackHeights([obj(1000, 100, 100)], { ...AR9, fileFormat: 5 }),
    ).toThrow(/fileFormat 5|legacy/);
  });
});

/* ---------------- 真实谱面上的不变量 ---------------- */

const FIXTURE_DIR = join(process.cwd(), 'fixtures');
const NAMES = ['stable', 'stable-hdfl', 'lazer', 'lazer-moonlight'];
const AVAILABLE = NAMES.filter((n) => existsSync(join(FIXTURE_DIR, `${n}.osu`)));

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe.skipIf(AVAILABLE.length === 0)('真实谱面上的堆叠', () => {
  for (const name of AVAILABLE) {
    describe(name, () => {
      let cached: ReturnType<typeof loadBeatmap> | undefined;
      const load = (): ReturnType<typeof loadBeatmap> => {
        cached ??= loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`)));
        return cached;
      };

      /**
       * 独立数一遍"候选对":时间落在阈值内、且位置(或滑条尾)距离 < 3。
       *
       * 不直接断言"应该有堆叠" —— `lazer.osu` 的 stackLeniency 只有 0.2
       * (阈值 111ms),实测候选对确实是 0,零堆叠是正确结果。
       * 所以判据是"有候选就必须有堆叠,没候选就必须没有"。
       */
      const countCandidates = async (): Promise<number> => {
        const { beatmap } = await load();
        const objects = beatmap.hitObjects;
        const threshold =
          preemptFromAR(beatmap.difficulty.approachRate) * beatmap.stackLeniency;

        let candidates = 0;
        for (let i = 1; i < objects.length; i++) {
          const a = objects[i]!;
          if (a.kind === 'spinner') continue;

          for (let n = i - 1; n >= 0; n--) {
            const b = objects[n]!;
            if (b.kind === 'spinner') continue;
            if (Math.trunc(a.startTime) - Math.trunc(b.endTime) > threshold) break;

            const dStart = Math.hypot(b.x - a.x, b.y - a.y);
            const dEnd = Math.hypot(b.endX - a.x, b.endY - a.y);
            if (dStart < STACK_DISTANCE || (b.kind === 'slider' && dEnd < STACK_DISTANCE)) {
              candidates++;
            }
          }
        }
        return candidates;
      };

      it('有候选对就必须产生堆叠,没候选对就必须没有', async () => {
        const { beatmap } = await load();
        const stacked = beatmap.hitObjects.filter((o) => o.stackHeight !== 0).length;
        const candidates = await countCandidates();

        if (candidates > 0) {
          expect(stacked, `有 ${candidates} 个候选对却一个堆叠都没有`).toBeGreaterThan(0);
        } else {
          expect(stacked, `没有候选对却产生了 ${stacked} 个堆叠`).toBe(0);
        }
      });

      it('堆叠层数在合理范围内 —— 失控的层数说明链式逻辑写错了', async () => {
        const { beatmap } = await load();
        for (const o of beatmap.hitObjects) {
          expect(Math.abs(o.stackHeight), `t=${o.startTime} 层数 ${o.stackHeight}`)
            .toBeLessThan(64);
        }
      });

      it('转盘的 stackHeight 恒为 0', async () => {
        const { beatmap } = await load();
        for (const o of beatmap.hitObjects) {
          if (o.kind === 'spinner') expect(o.stackHeight, `t=${o.startTime}`).toBe(0);
        }
      });

      it('stackedPosition = position + stackHeight * scale * -6.4', async () => {
        const { beatmap } = await load();
        const scale = radiusFromCS(beatmap.difficulty.circleSize) / OBJECT_RADIUS;

        for (const o of beatmap.hitObjects) {
          const expected = stackOffset(o.stackHeight, scale);
          expect(o.stackedX - o.x, `t=${o.startTime}`).toBeCloseTo(expected, 10);
          expect(o.stackedY - o.y, `t=${o.startTime}`).toBeCloseTo(expected, 10);
        }
      });

      it('stackHeight 为 0 的物件位置不变', async () => {
        const { beatmap } = await load();
        for (const o of beatmap.hitObjects) {
          if (o.stackHeight !== 0) continue;
          expect(o.stackedX).toBe(o.x);
          expect(o.stackedY).toBe(o.y);
        }
      });

      it('滑条末端位置存在且有限', async () => {
        const { beatmap } = await load();
        for (const o of beatmap.hitObjects) {
          expect(Number.isFinite(o.endX), `t=${o.startTime}`).toBe(true);
          expect(Number.isFinite(o.endY), `t=${o.startTime}`).toBe(true);
          // 非滑条的末端等于起点
          if (o.kind !== 'slider') {
            expect(o.endX).toBe(o.x);
            expect(o.endY).toBe(o.y);
          }
        }
      });

      it('偶数 span 的滑条末端回到起点附近', async () => {
        const { beatmap } = await load();
        const evenSpan = beatmap.hitObjects.filter(
          (o) => o.kind === 'slider' && o.spans % 2 === 0,
        );
        if (evenSpan.length === 0) return;

        for (const o of evenSpan) {
          // 来回一趟应回到起点。路径细分有浮点误差,给 1 单位容差
          const d = Math.hypot(o.endX - o.x, o.endY - o.y);
          expect(d, `t=${o.startTime} spans=${o.spans} 偏离 ${d.toFixed(3)}`).toBeLessThan(1);
        }
      });

      it('堆叠是确定性的 —— 同一谱面解两次结果一致', async () => {
        const a = await loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`)));
        const b = await loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`)));

        expect(a.beatmap.hitObjects.map((o) => o.stackHeight))
          .toEqual(b.beatmap.hitObjects.map((o) => o.stackHeight));
      });
    });
  }
});
