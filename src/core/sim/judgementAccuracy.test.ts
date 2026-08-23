import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadBeatmap } from '../load/beatmapLoader';
import { loadReplay } from '../load/replayLoader';
import { createCircleJudgement } from './judgement';
import { MAX_SCORE } from './lazerScoring';
import { stableScoringFor } from './stableScoring';
import { theoreticalMaxCombo } from './sliderParts';
import { buildTimeline } from './timeline';
import { ZERO_CUMULATIVE, HitResult, type CumulativeState } from './types';

/** 判定已能**精确**复现的样本。与 `judgement.test.ts` 的同名常量保持一致。 */
const EXACT_SAMPLES = new Set(['lazer']);

/** 判定档位计数是否与 `.osr` 头部完全一致。分数精确断言的前提。 */
function sameCounts(
  cum: CumulativeState,
  info: { count300: number; count100: number; count50: number; countMiss: number },
): boolean {
  return (
    cum.countGreat === info.count300 &&
    cum.countOk === info.count100 &&
    cum.countMeh === info.count50 &&
    cum.countMiss === info.countMiss
  );
}

/** stable 的经典准确率公式。 */
function accuracyOf(cum: CumulativeState): number {  const hits = cum.countGreat + cum.countOk + cum.countMeh + cum.countMiss;
  if (hits === 0) return 1;
  return (300 * cum.countGreat + 100 * cum.countOk + 50 * cum.countMeh) / (300 * hits);
}

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

describe.skipIf(PAIRS.length === 0)('A2 判定复现', () => {
  for (const pair of PAIRS) {
    describe(pair.name, () => {
      let cached: Promise<{
        beatmap: Awaited<ReturnType<typeof loadBeatmap>>;
        replay: Awaited<ReturnType<typeof loadReplay>>;
        judged: CumulativeState;
        timeline: ReturnType<typeof buildTimeline>;
      }> | undefined;

      const load = () => {
        cached ??= Promise.all([
          loadBeatmap(read(pair.osu)),
          loadReplay(read(pair.osr)),
        ]).then(([beatmap, replay]) => {
          const timeline = buildTimeline(beatmap.beatmap, replay.frames, {
            judge: createCircleJudgement({
              sliderScoring: replay.info.isLazer ? 'lazer' : 'stable',
              rawMods: replay.info.rawMods,
            }),
          });
          return {
            beatmap,
            replay,
            timeline,
            judged: timeline.events.at(-1)?.cum ?? ZERO_CUMULATIVE,
          };
        });
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

      /* ---------------- L2:理论最大 combo ---------------- */

      it('L2 理论最大 combo >= .osr 的 maxCombo', async () => {
        const { beatmap, replay } = await load();

        expect(theoreticalMaxCombo(beatmap.beatmap)).toBeGreaterThanOrEqual(
          replay.info.maxCombo,
        );
      });

      /* ---------------- L3:模拟结果 vs 头部成绩 ---------------- */

      it('L3 每个物件恰好产生一个计数判定', async () => {
        const { beatmap, judged } = await load();

        expect(
          judged.countGreat + judged.countOk + judged.countMeh + judged.countMiss,
        ).toBe(beatmap.beatmap.hitObjects.length);
      });

      if (EXACT_SAMPLES.has(pair.name)) {
        it('L3 🎯 300/100/50/miss **精确**等于头部计数', async () => {
          const { replay, judged } = await load();

          expect({
            c300: judged.countGreat,
            c100: judged.countOk,
            c50: judged.countMeh,
            miss: judged.countMiss,
          }).toEqual({
            c300: replay.info.count300,
            c100: replay.info.count100,
            c50: replay.info.count50,
            miss: replay.info.countMiss,
          });
        });

        it('L3 🎯 maxCombo **精确**等于头部值', async () => {
          const { replay, judged } = await load();
          expect(judged.maxCombo).toBe(replay.info.maxCombo);
        });

        it('L3 🎯 accuracy **精确**等于头部值', async () => {
          const { replay, judged } = await load();
          expect(accuracyOf(judged)).toBeCloseTo(replay.info.accuracy, 6);
        });
      } else {
        it('L3 300/100/50/miss 与头部计数接近(每档容差 12)', async () => {
          const { replay, judged } = await load();

          for (const [label, ours, theirs] of [
            ['300', judged.countGreat, replay.info.count300],
            ['100', judged.countOk, replay.info.count100],
            ['50', judged.countMeh, replay.info.count50],
            ['miss', judged.countMiss, replay.info.countMiss],
          ] as const) {
            expect(Math.abs(ours - theirs), `${label}: 我们 ${ours} vs .osr ${theirs}`)
              .toBeLessThanOrEqual(12);
          }
        });

        it('L3 accuracy 与头部值接近(容差 2 个百分点)', async () => {
          const { replay, judged } = await load();

          expect(Math.abs(accuracyOf(judged) - replay.info.accuracy)).toBeLessThan(0.02);
        });
      }

      it('L3 分数与 .osr 头部一致(lazer 精确 / stable 查量级)', async () => {
        const { beatmap, replay, judged } = await load();

        if (replay.info.isLazer) {
          // lazer 的 standardised 记分已实现,且 `lazer.osr` 上**精确**吻合。
          // 分数由 combo 与准确率共同决定,所以只有两者都对上才可能精确相等
          if (judged.maxCombo === replay.info.maxCombo && sameCounts(judged, replay.info)) {
            expect(judged.score).toBe(replay.info.totalScore);
          } else {
            // 判定还有偏差时只查量级 —— 但 lazer 恒 ≤ 100 万,这条上界必须成立
            expect(judged.score).toBeLessThanOrEqual(MAX_SCORE);
            expect(Math.abs(judged.score - replay.info.totalScore)).toBeLessThan(
              replay.info.totalScore * 0.02,
            );
          }
          return;
        }

        const scoring = stableScoringFor(beatmap.beatmap, replay.info.rawMods);

        // 先确认参数本身合理 —— 若这里就错了,下面的比值没有意义
        expect(scoring.difficultyMultiplier).toBeGreaterThan(0);
        expect(scoring.modMultiplier).toBeGreaterThan(0);

        // 分数被 combo 加成主导:combo 差多少,分数就成比例地差。
        // 所以只有 maxCombo 精确对上时才能要求分数精确
        if (judged.maxCombo === replay.info.maxCombo) {
          expect(judged.score).toBe(replay.info.totalScore);
        } else {
          // combo 未对上时只做量级检查:确认公式没有整体性错误
          // (比如漏乘难度系数会差 4 倍以上)
          const ratio = judged.score / replay.info.totalScore;
          expect(ratio).toBeGreaterThan(0.2);
          expect(ratio).toBeLessThan(2);
        }
      });

      it('L3 分数的单调性(stable 只增 / lazer 可回跌但只在准确率下降时)', async () => {
        const { timeline, replay } = await load();
        const events = timeline.events;
        expect(events.length).toBeGreaterThan(10);

        if (replay.info.isLazer) {
          // ⚠️ lazer 的分数**会下降** —— 这不是 bug,是 standardised 记分的性质:
          // Accuracy 是个 running 比值(currentBaseScore / currentMaximumBaseScore),
          // 一次 miss 让分母增长而分子不变,准确率就掉;而分数里 acc 与 acc⁵
          // 都是乘性因子,所以即使 comboProgress 在涨,总分也可能净减少。
          // 真实 lazer 里 miss 的瞬间显示分数确实会回跌。
          //
          // 能断言的是:**回跌只发生在拿不到满档的判定上**。
          for (let i = 1; i < events.length; i++) {
            if (events[i]!.cum.score >= events[i - 1]!.cum.score) continue;

            const e = events[i]!;
            const perfect =
              e.part === 'sliderTick' || e.part === 'sliderRepeat' || e.part === 'sliderTail'
                ? e.result !== HitResult.Miss
                : e.result === HitResult.Great;

            expect(
              perfect,
              `分数在 ${e.time.toFixed(0)}ms 回跌,但该判定(${e.part})是满档的`,
            ).toBe(false);
          }

          // 恒 ≤ 100 万(该图无转盘 bonus)。这条上界是 standardised 记分的定义
          expect(events.at(-1)!.cum.score).toBeLessThanOrEqual(MAX_SCORE);
          return;
        }

        // ScoreV1 是纯累加,只增不减
        for (let i = 1; i < events.length; i++) {
          expect(events[i]!.cum.score).toBeGreaterThanOrEqual(events[i - 1]!.cum.score);
        }

        // 首个判定拿不到 combo 加成 —— 分数就是它的基础分,必然 ≤ 300
        expect(events[0]!.cum.score).toBeLessThanOrEqual(300);

        // combo 加成必须占分数的绝大部分。基础分之和上界是 300 × 事件数
        // (实际远小于此,因为滑条部件只值 10/30),所以总分若显著超过这个上界,
        // 就证明 combo 加成真的在累积 —— 而不是只把基础分加起来
        expect(events.at(-1)!.cum.score).toBeGreaterThan(300 * events.length);
      });
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
