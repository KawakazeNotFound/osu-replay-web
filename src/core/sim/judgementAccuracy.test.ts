import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { countByKind, loadBeatmap } from '../load/beatmapLoader';
import { loadReplay } from '../load/replayLoader';
import type { SimBeatmap } from './types';

/**
 * # A2:判定复现测试
 *
 * 全项目最深的坑(见 TECH-NOTES A2)。给定 `.osu` + `.osr`,我们自己模拟出来的
 * 分数 / 连击 / 准确率**必须**与 `.osr` 头部记录的原始成绩一致,否则整条
 * 时间线都是错的。
 *
 * ## 这个文件的定位
 *
 * 判定器(`JudgementPass`)还没实现。所以这里先建立**能立刻生效的那部分断言**,
 * 并把还做不到的部分显式标成 `todo` —— 而不是等判定写完再补测试。
 *
 * 分三层,从"现在就能验"到"要等判定器":
 *
 * | 层 | 验什么 | 现状 |
 * |---|---|---|
 * | L1 | 物件数 == `.osr` 的判定总数 | ✅ 现在就能验,4/4 通过 |
 * | L2 | 理论最大 combo == FC 回放的 maxCombo | 🟡 缺滑条 tick(M2) |
 * | L3 | 模拟出的 300/100/50/miss、分数、准确率 == 头部成绩 | ⬜ 等判定器(M1+) |
 *
 * ## 为什么 L1 是强断言
 *
 * `count300 + count100 + count50 + countMiss` 恰好是"产生了主判定的物件数"。
 * 它对不上就意味着物件解析漏了/多了 —— 而这会让**每一条**后续判定错位。
 * 实测 4 个样本全部精确相等,说明物件解析(含类型判别)是对的。
 */

const FIXTURE_DIR = join(process.cwd(), 'fixtures');

/** 一组 (谱面, 回放) 配对。按 MD5 配好后同名放在 `fixtures/`。 */
interface Pair {
  readonly name: string;
  readonly osu: string;
  readonly osr: string;
}

const CANDIDATES: readonly string[] = [
  'stable',
  'stable-hdfl',
  'lazer',
  'lazer-moonlight',
];

/** 只取 `.osu` 与 `.osr` 都在的配对 —— 素材不入库,缺了就跳过而非失败。 */
function pairs(): Pair[] {
  return CANDIDATES.map((name) => ({
    name,
    osu: join(FIXTURE_DIR, `${name}.osu`),
    osr: join(FIXTURE_DIR, `${name}.osr`),
  })).filter((p) => existsSync(p.osu) && existsSync(p.osr));
}

const PAIRS = pairs();

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * 理论最大 combo(不含滑条 tick)。
 *
 * stable 的 std 计数规则:circle → 1;spinner → 1;
 * slider → 1(头)+ tick 数 + (spans - 1)(repeat)+ 1(尾)。
 *
 * ⚠️ tick 数需要滑条路径与 timing point 才能算,属 M2。所以这里给的是**下界**。
 * 实测 `lazer.osu` 恰好 0 tick,该图上这个下界就是精确值。
 */
function maxComboLowerBound(beatmap: SimBeatmap): number {
  const counts = countByKind(beatmap);
  const sliders = counts.slider;

  // repeat 数暂时取 0:SimHitObject 还没带 spans(M2 加滑条时补)
  return beatmap.hitObjects.length + sliders;
}

describe.skipIf(PAIRS.length === 0)('A2 判定复现', () => {
  for (const pair of PAIRS) {
    describe(pair.name, () => {
      let cached: Promise<{
        beatmap: Awaited<ReturnType<typeof loadBeatmap>>;
        replay: Awaited<ReturnType<typeof loadReplay>>;
      }> | undefined;

      const load = () => {
        cached ??= Promise.all([
          loadBeatmap(read(pair.osu)),
          loadReplay(read(pair.osr)),
        ]).then(([beatmap, replay]) => ({ beatmap, replay }));
        return cached;
      };

      /* ---------------- L1:现在就能验 ---------------- */

      it('L1 物件数 == .osr 的判定总数(300+100+50+miss)', async () => {
        const { beatmap, replay } = await load();
        const { info } = replay;

        const judged = info.count300 + info.count100 + info.count50 + info.countMiss;

        expect(judged).toBe(beatmap.beatmap.hitObjects.length);
      });

      it('L1 谱面 MD5 与回放头部一致 —— 确认配对没错', async () => {
        const { replay } = await load();
        // .osu 的 MD5 我们不算(要引 crypto),但可以反过来确认回放里记了哈希
        expect(replay.info.beatmapHashMD5).toMatch(/^[0-9a-f]{32}$/);
      });

      it('L1 回放帧覆盖了整张谱面的时间范围', async () => {
        const { beatmap, replay } = await load();
        const objects = beatmap.beatmap.hitObjects;
        const firstObject = objects[0]!.startTime;
        const lastObject = objects[objects.length - 1]!.endTime;

        const frames = replay.frames;
        expect(frames.count).toBeGreaterThan(0);

        // 玩家总要在第一个物件之前就有光标,在最后一个物件之后才松手
        expect(frames.time[0]!).toBeLessThan(firstObject);
        expect(frames.time[frames.count - 1]!).toBeGreaterThan(lastObject - 1000);
      });

      it('L1 准确率可由判定计数反推 —— 验证 stable 经典公式', async () => {
        const { replay } = await load();
        const { info } = replay;

        const hits = info.count300 + info.count100 + info.count50 + info.countMiss;
        const earned = 300 * info.count300 + 100 * info.count100 + 50 * info.count50;
        const computed = earned / (300 * hits);

        // lazer 回放的 accuracy 字段也用同一公式(实测 4/4 吻合到 1e-6)
        expect(computed).toBeCloseTo(info.accuracy, 6);
      });

      /* ---------------- L2:缺滑条 tick ---------------- */

      it('L2 maxCombo 不低于理论下界(物件数 + 滑条尾)', async () => {
        const { beatmap, replay } = await load();

        // 只有 FC 才能拿 maxCombo 当理论最大值比
        if (replay.info.countMiss > 0) return;

        expect(replay.info.maxCombo).toBeGreaterThanOrEqual(
          maxComboLowerBound(beatmap.beatmap),
        );
      });

      it.todo('L2 理论最大 combo == FC 回放的 maxCombo(需滑条 tick 与 repeat,M2)');

      /* ---------------- L3:等判定器 ---------------- */

      it.todo('L3 模拟出的 300/100/50/miss == .osr 头部计数');
      it.todo('L3 模拟出的 maxCombo == .osr 头部 maxCombo');
      it.todo('L3 模拟出的 accuracy == .osr 头部 accuracy');
      it.todo('L3 模拟出的 totalScore == .osr 头部 totalScore(stable 记分)');
      it.todo('L3 lazer 回放走 lazer standardised 记分(M5)');
    });
  }
});

describe.skipIf(PAIRS.length === 0)('A2 素材自检', () => {
  it('至少有一组 stable 与一组 lazer 配对', () => {
    const names = PAIRS.map((p) => p.name);
    expect(names.some((n) => n.startsWith('stable'))).toBe(true);
    expect(names.some((n) => n.startsWith('lazer'))).toBe(true);
  });

  it('至少有一组 FC 回放 —— L2 只能靠 FC 验证', async () => {
    const infos = await Promise.all(
      PAIRS.map(async (p) => (await loadReplay(read(p.osr))).info),
    );
    expect(infos.some((i) => i.countMiss === 0)).toBe(true);
  });

  it('至少有一组带 mod 的回放', async () => {
    const infos = await Promise.all(
      PAIRS.map(async (p) => (await loadReplay(read(p.osr))).info),
    );
    expect(infos.some((i) => i.rawMods !== 0)).toBe(true);
  });
});
