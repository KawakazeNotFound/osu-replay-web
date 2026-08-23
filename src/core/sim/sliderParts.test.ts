import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadBeatmap } from '../load/beatmapLoader';
import { loadReplay } from '../load/replayLoader';
import {
  comboBreakdown,
  comboContributionOf,
  theoreticalMaxCombo,
  tickCountOf,
  tickDistanceOf,
} from './sliderParts';
import { makeHitObject } from './testFixtures';
import type { SimHitObject } from './types';

/* ---------------- 纯函数 ---------------- */

function slider(overrides: Partial<Parameters<typeof tickCountOf>[0]> = {}) {
  return {
    pathDistance: 1000,
    velocity: 0.5,
    spans: 1,
    beatLength: 300,
    sliderTickRate: 1,
    ...overrides,
  };
}

describe('tickDistanceOf', () => {
  it('= velocity * beatLength / tickRate', () => {
    expect(tickDistanceOf(slider({ velocity: 0.5, beatLength: 300, sliderTickRate: 1 })))
      .toBeCloseTo(150, 10);
    expect(tickDistanceOf(slider({ velocity: 0.5, beatLength: 300, sliderTickRate: 2 })))
      .toBeCloseTo(75, 10);
  });

  it('刻意不化简成 BASE_SCORING_DISTANCE * sliderMultiplier', () => {
    // lazer 注释:"intentionally introducing floating point errors to match stable"。
    // 这条只是把意图写进测试:公式必须经由 velocity,而不是常量乘法。
    const input = slider({ velocity: 0.15554972, beatLength: 327.868852459016 });
    expect(tickDistanceOf(input)).toBeCloseTo(input.velocity * input.beatLength, 12);
  });
});

describe('tickCountOf', () => {
  it('刻度按 tickDistance 步长铺,末端留出 velocity*10', () => {
    // tickDistance = 0.5*300 = 150;limit = 1000 - 0.5*10 = 995
    // 刻度在 150,300,...,900 → 6 个(1050 > 995 停)
    expect(tickCountOf(slider())).toBe(6);
  });

  it('每个 span 各铺一遍', () => {
    expect(tickCountOf(slider({ spans: 2 }))).toBe(12);
    expect(tickCountOf(slider({ spans: 3 }))).toBe(18);
  });

  it('tickDistance 超过路径长度 → 0 个刻度', () => {
    // 这正是 lazer.osu 的情形:tickDistance ~170 > 路径 128
    expect(tickCountOf(slider({ pathDistance: 128, velocity: 0.374, beatLength: 455 })))
      .toBe(0);
  });

  it('末端保留距离生效 —— 恰好落在 limit 上的刻度不算', () => {
    // 构造:limit 恰好等于某个刻度距离。判据是严格小于,所以该刻度被丢掉
    const input = slider({ pathDistance: 1000, velocity: 0.5, beatLength: 300 });
    const limit = 1000 - 0.5 * 10; // 995
    const tickDistance = tickDistanceOf(input); // 150
    // 把 pathDistance 调成让 limit 正好等于 900
    const tuned = slider({ pathDistance: 900 + 0.5 * 10, velocity: 0.5, beatLength: 300 });
    expect(limit).toBe(995);
    expect(tickDistance).toBe(150);
    // limit = 900 时,刻度 900 不算 → 只剩 150..750 共 5 个
    expect(tickCountOf(tuned)).toBe(5);
  });

  it('velocity 或 tickRate 异常时返回 0 而不是 NaN/无限循环', () => {
    expect(tickCountOf(slider({ velocity: 0 }))).toBe(0);
    expect(tickCountOf(slider({ sliderTickRate: 0 }))).toBe(0);
  });
});

describe('comboContributionOf', () => {
  const base = (kind: SimHitObject['kind'], spans = 1, tickCount = 0): SimHitObject =>
    makeHitObject({ kind, spans, tickCount });

  it('circle 与 spinner 各贡献 1', () => {
    expect(comboContributionOf(base('circle'))).toBe(1);
    expect(comboContributionOf(base('spinner'))).toBe(1);
  });

  it('滑条 = 1(头)+ 刻度 + repeat + 1(尾)', () => {
    expect(comboContributionOf(base('slider', 1, 0))).toBe(2); // 头 + 尾
    expect(comboContributionOf(base('slider', 1, 3))).toBe(5); // 头 + 3 刻度 + 尾
    expect(comboContributionOf(base('slider', 3, 0))).toBe(4); // 头 + 2 repeat + 尾
    expect(comboContributionOf(base('slider', 2, 4))).toBe(7); // 头 + 4 刻度 + 1 repeat + 尾
  });
});

/* ---------------- 真实谱面 ---------------- */

const FIXTURE_DIR = join(process.cwd(), 'fixtures');
const NAMES = ['stable', 'stable-hdfl', 'lazer', 'lazer-moonlight'];
const AVAILABLE = NAMES.filter(
  (n) => existsSync(join(FIXTURE_DIR, `${n}.osu`)) && existsSync(join(FIXTURE_DIR, `${n}.osr`)),
);

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * `lazer.osu` 那张回放实测是**真 full combo**:理论最大 combo 恰好等于
 * `.osr` 记录的 maxCombo(346)。所以它可以做等式断言。
 *
 * 其余样本只能做上界断言 —— 见下面关于 slider break 的说明。
 */
const TRUE_FULL_COMBO = new Set(['lazer']);

describe.skipIf(AVAILABLE.length === 0)('真实谱面的理论最大 combo', () => {
  for (const name of AVAILABLE) {
    describe(name, () => {
      const load = async () => {
        const [bm, rp] = await Promise.all([
          loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`))),
          loadReplay(read(join(FIXTURE_DIR, `${name}.osr`))),
        ]);
        return { bm, rp };
      };

      /**
       * # 上界断言
       *
       * `.osr` 的 maxCombo 是玩家**实际达到**的最长连击,理论最大 combo 是
       * 全部部件都命中时的值 —— 前者永远 `<=` 后者。
       *
       * ⚠️ **不能反过来当等式用。** `countMiss == 0` 不等于 full combo:
       * stable 里漏掉滑条尾或某个刻度会产生 **slider break**,它打断 combo
       * 但**不计入 miss**。
       *
       * 我曾用"FC 回放的 maxCombo"反推刻度数,推出 `stable.osu` 应有 18 个,
       * 而公式给 19,以为公式错了。实际是前提错了:那张 0 miss 的回放理论最大
       * 1152、实得 1151(最后一条滑条断了一次)。
       */
      it('理论最大 combo >= .osr 的 maxCombo', async () => {
        const { bm, rp } = await load();
        const theoretical = theoreticalMaxCombo(bm.beatmap);

        expect(theoretical, `理论 ${theoretical} < 实际 ${rp.info.maxCombo},不可能`)
          .toBeGreaterThanOrEqual(rp.info.maxCombo);
      });

      it('构成 = 物件数 + 刻度 + repeat + 滑条尾', async () => {
        const { bm } = await load();
        const b = comboBreakdown(bm.beatmap);

        expect(b.total).toBe(theoreticalMaxCombo(bm.beatmap));
        expect(b.objects).toBe(bm.beatmap.hitObjects.length);
        expect(b.tails).toBe(bm.beatmap.hitObjects.filter((o) => o.kind === 'slider').length);
      });

      it('非滑条物件的 tickCount 为 0', async () => {
        const { bm } = await load();
        for (const o of bm.beatmap.hitObjects) {
          if (o.kind !== 'slider') expect(o.tickCount, `${o.kind}@${o.startTime}`).toBe(0);
        }
      });

      it('刻度数是非负整数', async () => {
        const { bm } = await load();
        for (const o of bm.beatmap.hitObjects) {
          expect(Number.isInteger(o.tickCount), `@${o.startTime}`).toBe(true);
          expect(o.tickCount).toBeGreaterThanOrEqual(0);
        }
      });

      if (TRUE_FULL_COMBO.has(name)) {
        it('真 full combo:理论最大 combo **精确等于** .osr 的 maxCombo', async () => {
          const { bm, rp } = await load();
          const b = comboBreakdown(bm.beatmap);

          expect(
            theoreticalMaxCombo(bm.beatmap),
            `构成:物件 ${b.objects} + 刻度 ${b.ticks} + repeat ${b.repeats} + 尾 ${b.tails}`,
          ).toBe(rp.info.maxCombo);
        });
      }
    });
  }
});
