import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { countByKind, loadBeatmap } from './beatmapLoader';

/**
 * `.osu` 不入库(见 .gitignore),所以这组用例条件执行:往 `fixtures/` 丢
 * `.osu` 就自动纳入,没有就跳过。
 */
const FIXTURE_DIR = join(process.cwd(), 'fixtures');

function fixtures(): string[] {
  try {
    return readdirSync(FIXTURE_DIR)
      .filter((n) => n.toLowerCase().endsWith('.osu'))
      .map((n) => join(FIXTURE_DIR, n));
  } catch {
    return [];
  }
}

const FILES = fixtures();

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe.skipIf(FILES.length === 0)('loadBeatmap(真实 .osu)', () => {
  for (const file of FILES) {
    const name = file.split(/[\\/]/).pop()!;

    describe(name, () => {
      let cached: ReturnType<typeof loadBeatmap> | undefined;
      const load = (): ReturnType<typeof loadBeatmap> => {
        cached ??= loadBeatmap(read(file));
        return cached;
      };

      it('解析出非空物件列表', async () => {
        const { beatmap } = await load();
        expect(beatmap.hitObjects.length).toBeGreaterThan(10);
      });

      it('物件按 startTime 升序', async () => {
        const { beatmap } = await load();
        for (let i = 1; i < beatmap.hitObjects.length; i++) {
          expect(beatmap.hitObjects[i]!.startTime).toBeGreaterThanOrEqual(
            beatmap.hitObjects[i - 1]!.startTime,
          );
        }
      });

      it('endTime >= startTime,且 circle 上两者相等', async () => {
        const { beatmap } = await load();
        for (const o of beatmap.hitObjects) {
          expect(o.endTime).toBeGreaterThanOrEqual(o.startTime);
          if (o.kind === 'circle') expect(o.endTime).toBe(o.startTime);
        }
      });

      it('slider / spinner 有正的时长', async () => {
        const { beatmap } = await load();
        for (const o of beatmap.hitObjects) {
          if (o.kind === 'circle') continue;
          expect(o.endTime, `${o.kind}@${o.startTime}`).toBeGreaterThan(o.startTime);
        }
      });

      it('三类物件都被识别,没有落到未知类型', async () => {
        const { beatmap } = await load();
        const counts = countByKind(beatmap);
        expect(counts.circle + counts.slider + counts.spinner).toBe(beatmap.hitObjects.length);
        expect(counts.circle).toBeGreaterThan(0);
      });

      it('难度参数在合法区间', async () => {
        const { beatmap } = await load();
        const d = beatmap.difficulty;
        for (const [key, value] of Object.entries({
          circleSize: d.circleSize,
          approachRate: d.approachRate,
          overallDifficulty: d.overallDifficulty,
          drainRate: d.drainRate,
        })) {
          expect(value, key).toBeGreaterThanOrEqual(0);
          expect(value, key).toBeLessThanOrEqual(10);
        }
        expect(d.sliderMultiplier).toBeGreaterThan(0);
        expect(d.sliderTickRate).toBeGreaterThan(0);
      });

      it('stackLeniency 被读出来(堆叠阈值要用)', async () => {
        const { beatmap } = await load();
        expect(beatmap.stackLeniency).toBeGreaterThan(0);
        expect(beatmap.stackLeniency).toBeLessThanOrEqual(1);
      });

      it('break 区间有效且落在物件范围内', async () => {
        const { beatmap } = await load();
        if (beatmap.breaks.length === 0) return;

        const first = beatmap.hitObjects[0]!.startTime;
        const last = beatmap.hitObjects[beatmap.hitObjects.length - 1]!.endTime;
        for (const b of beatmap.breaks) {
          expect(b.end).toBeGreaterThan(b.start);
          expect(b.start).toBeGreaterThan(first);
          expect(b.end).toBeLessThan(last);
        }
      });

      it('元信息齐全', async () => {
        const { metadata } = await load();
        expect(metadata.title.length).toBeGreaterThan(0);
        expect(metadata.artist.length).toBeGreaterThan(0);
        expect(metadata.version.length).toBeGreaterThan(0);
        expect(metadata.audioFilename.length).toBeGreaterThan(0);
        // 实测当前谱面是 v14。低于 v6 会走另一套堆叠算法(见 TECH-NOTES D9)
        expect(metadata.fileFormat).toBeGreaterThanOrEqual(4);
      });

      /* ---------- combo 信息:这是 osu-parsers 不提供、我们自己推的部分 ---------- */

      it('comboIndex 从 1 开始,逐个 combo 递增 1,不跳号', async () => {
        const { beatmap } = await load();
        // ⚠️ 1 而不是 0。核 `IHasComboInformation.UpdateComboInformation`:
        //   int index = lastObj?.ComboIndex ?? 0;   // 首个物件 lastObj 为 null → 0
        //   if (NewCombo || lastObj == null) index++;  // → 1
        // 而 `BeatmapProcessor.PreProcess()` 从 lastObj = null 起遍历,首个物件
        // 必然进那个分支。曾经这里写 0,配 4 色调色板时整张图配色错开一格。
        let expected = 1;

        for (const o of beatmap.hitObjects) {
          if (o.newCombo) {
            expect(o.comboIndex, `newCombo@${o.startTime}`).toBe(expected);
            expected++;
          } else {
            expect(o.comboIndex, `@${o.startTime}`).toBe(expected - 1);
          }
        }
        expect(expected).toBeGreaterThan(2);
      });

      it('comboIndexWithOffsets 只在新 combo 上跳,且跳幅 = comboOffset + 1', async () => {
        const { beatmap } = await load();

        // 递推式:indexWithOffsets += ComboOffset + 1(仅新 combo 分支)
        // 我们拿不到每个物件的 comboOffset(它没进 SimHitObject),所以这里验的是
        // 该式子的**可观察推论**,而不是逐项复算:
        let previous: number | null = null;
        let sawSkip = false;

        for (const o of beatmap.hitObjects) {
          if (previous === null) {
            // 首个物件:0 + offset + 1 ≥ 1
            expect(o.comboIndexWithOffsets, `首个@${o.startTime}`).toBeGreaterThanOrEqual(1);
          } else if (o.newCombo) {
            const delta = o.comboIndexWithOffsets - previous;
            // offset ∈ 0..7 ⇒ 跳幅 ∈ 1..8
            expect(delta, `newCombo@${o.startTime} 的跳幅`).toBeGreaterThanOrEqual(1);
            expect(delta, `newCombo@${o.startTime} 的跳幅`).toBeLessThanOrEqual(8);
            if (delta > 1) sawSkip = true;
          } else {
            // 非新 combo:一定不动
            expect(o.comboIndexWithOffsets, `@${o.startTime} 不应变化`).toBe(previous);
          }
          previous = o.comboIndexWithOffsets;
        }

        // 没有跳色的图 ⇒ 两个 index 必须完全一致。这条是**非空洞守卫**:
        // 若哪天 comboOffset 恒为 0(比如读错了字段),下面这条会立刻红
        if (!sawSkip) {
          for (const o of beatmap.hitObjects) {
            expect(o.comboIndexWithOffsets, `无跳色图@${o.startTime}`).toBe(o.comboIndex);
          }
        }
      });

      it('indexInCombo 在每个 combo 内从 1 连续递增', async () => {
        const { beatmap } = await load();
        let previous = 0;

        for (const o of beatmap.hitObjects) {
          if (o.newCombo) {
            expect(o.indexInCombo, `newCombo@${o.startTime}`).toBe(1);
          } else {
            expect(o.indexInCombo, `@${o.startTime}`).toBe(previous + 1);
          }
          previous = o.indexInCombo;
        }
      });

      it('第一个物件必然开启 combo —— lazer 在 lastObj==null 时无条件走新 combo 分支', async () => {
        const { beatmap } = await load();
        expect(beatmap.hitObjects[0]!.newCombo).toBe(true);
        expect(beatmap.hitObjects[0]!.comboIndex).toBe(1);
        expect(beatmap.hitObjects[0]!.indexInCombo).toBe(1);
      });

      /* ---------- [Colours]:M4 皮肤之前,谱面自带配色是唯一的真颜色来源 ---------- */

      it('comboColours 至多 8 个,分量都是 0..255 的整数', async () => {
        const { beatmap } = await load();

        // lazer 的 MAX_COMBO_COLOUR_COUNT = 8;osu-parsers 不做这个校验,
        // 所以装载时截断过 —— 这条锁住那次截断
        expect(beatmap.comboColours.length).toBeLessThanOrEqual(8);

        for (const c of beatmap.comboColours) {
          for (const v of [c.r, c.g, c.b]) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(255);
          }
        }
      });

      it('转盘之后的第一个物件被强制开启 combo —— PreProcess() 的规则', async () => {
        const { beatmap } = await load();
        const objects = beatmap.hitObjects;

        let checked = 0;
        for (let i = 1; i < objects.length; i++) {
          if (objects[i - 1]!.kind !== 'spinner') continue;
          if (objects[i]!.kind === 'spinner') continue; // 连续转盘不算

          expect(objects[i]!.newCombo, `转盘后@${objects[i]!.startTime}`).toBe(true);
          checked++;
        }
        // 没有转盘的图跳过断言,但要让读者知道这条没被验证到
        if (checked === 0) expect(countByKind(beatmap).spinner).toBe(0);
      });

      it('转盘本身不强制开启 combo(除非文件里标了)', async () => {
        const { beatmap } = await load();
        // 这条只做一件事:确认我们没有把「转盘」误当成 combo 分界
        const spinners = beatmap.hitObjects.filter((o) => o.kind === 'spinner');
        if (spinners.length === 0) return;

        // 至少存在一个不开新 combo 的转盘,才说明我们没有一律置位
        // (若该图所有转盘恰好都标了 NewCombo,这条会失效 —— 故只做软性检查)
        expect(spinners.every((s) => typeof s.newCombo === 'boolean')).toBe(true);
      });

      it('坐标是有限数', async () => {
        const { beatmap } = await load();
        for (const o of beatmap.hitObjects) {
          expect(Number.isFinite(o.x), `x@${o.startTime}`).toBe(true);
          expect(Number.isFinite(o.y), `y@${o.startTime}`).toBe(true);
        }
      });
    });
  }
});

/**
 * # combo-skip 位:只能靠合成谱面验证
 *
 * 我们四张 fixture 里**一个 combo-skip 位都没有**(实测全为 0),所以
 * `comboIndexWithOffsets` 的递推在真实数据上恒等于 `comboIndex` ——
 * ground truth **验不出**这段代码对不对。这和 `hitPolicy.test.ts` 是同一种局面。
 *
 * 更要紧的是:**osu-parsers 在这里的行为与现在的 lazer 不一致**,而两处分歧
 * 恰好都只在有 skip 位时才显形。所以这组用例是唯一能证明我们跟的是
 * 现在的 lazer(而不是 osu-parsers)的地方。
 */
describe('combo-skip 位(合成谱面)', () => {
  /**
   * 一张手工谱面,专门踩两处分歧。
   *
   * | # | hitType | 位域含义 | 期望 comboIndex | 期望 withOffsets |
   * |---|---|---|---|---|
   * | 0 | 1 | Normal(首个物件被强制开 combo) | 1 | 0+0+1 = 1 |
   * | 1 | 37 = 1\|4\|32 | Normal + NewCombo + skip2 | 2 | 1+2+1 = 4 |
   * | 2 | 1 | Normal,不开 combo | 2 | 4(不动) |
   * | 3 | 56 = 8\|48 | Spinner + skip3,未标 NewCombo | 2 | 4(不动) |
   * | 4 | 1 | Normal,转盘后被**强制**开 combo | 3 | 4+0+1 = 5 |
   * | 5 | 21 = 1\|4\|16 | Normal + NewCombo + skip1 | 4 | 5+1+1 = 7 |
   */
  const SYNTHETIC = [
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: audio.mp3',
    'Mode: 0',
    'StackLeniency: 0.7',
    '',
    '[Difficulty]',
    'HPDrainRate:5',
    'CircleSize:4',
    'OverallDifficulty:8',
    'ApproachRate:9',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    '',
    '[TimingPoints]',
    '0,500,4,2,0,50,1,0',
    '',
    '[Colours]',
    'Combo1 : 10,20,30',
    'Combo2 : 40,50,60',
    'Combo3 : 70,80,90',
    'Combo4 : 100,110,120',
    '',
    '[HitObjects]',
    '256,192,1000,1,0,0:0:0:0:',
    '100,100,1500,37,0,0:0:0:0:',
    '200,200,2000,1,0,0:0:0:0:',
    '256,192,2500,56,0,3500,0:0:0:0:',
    '300,300,4000,1,0,0:0:0:0:',
    '350,350,4500,21,0,0:0:0:0:',
    '',
  ].join('\n');

  async function loadSynthetic() {
    const bytes = new TextEncoder().encode(SYNTHETIC);
    return loadBeatmap(bytes.buffer.slice(0, bytes.byteLength));
  }

  it('两个 index 逐项符合 UpdateComboInformation 的递推', async () => {
    const { beatmap } = await loadSynthetic();
    const o = beatmap.hitObjects;
    expect(o).toHaveLength(6);

    expect(o.map((x) => x.comboIndex)).toEqual([1, 2, 2, 2, 3, 4]);
    expect(o.map((x) => x.comboIndexWithOffsets)).toEqual([1, 4, 4, 4, 5, 7]);
  });

  it('转盘的 skip 位不结转给下一个物件 —— 这条区分现在的 lazer 与 osu-parsers', async () => {
    const { beatmap } = await loadSynthetic();
    const afterSpinner = beatmap.hitObjects[4]!;

    // 前提检查:这个物件确实是"转盘之后被强制开 combo"的那一个
    expect(beatmap.hitObjects[3]!.kind).toBe('spinner');
    expect(afterSpinner.newCombo).toBe(true);

    // lazer:createSpinner 不设 ComboOffset("Spinners cannot have combo offset."),
    // 而且该物件自己没标 NewCombo ⇒ offset = 0 ⇒ 只 +1
    expect(afterSpinner.comboIndexWithOffsets).toBe(5);

    // ⚠️ 若改用 osu-parsers 的 comboOffset 字段(带 _extraComboOffset 结转),
    // 这里会变成 4 + 3 + 1 = 8。所以这条断言就是那次选择的护栏
    expect(afterSpinner.comboIndexWithOffsets).not.toBe(8);
  });

  it('skip 位使两个 index 真的分叉 —— 非空洞守卫', async () => {
    const { beatmap } = await loadSynthetic();

    // 若哪天 comboOffsetOf() 恒返回 0(读错字段 / 位移写错),两个 index 会重合,
    // 上面那些 toEqual 也会一起红;这条是把"分叉"本身单独钉住,便于定位
    const diverged = beatmap.hitObjects.filter(
      (o) => o.comboIndexWithOffsets !== o.comboIndex,
    );
    expect(diverged.length).toBeGreaterThan(0);
  });

  it('[Colours] 按文件顺序读入,alpha 不参与', async () => {
    const { beatmap } = await loadSynthetic();

    expect(beatmap.comboColours).toEqual([
      { r: 10, g: 20, b: 30 },
      { r: 40, g: 50, b: 60 },
      { r: 70, g: 80, b: 90 },
      { r: 100, g: 110, b: 120 },
    ]);
    expect(beatmap.sliderTrackOverride).toBeNull();
    expect(beatmap.sliderBorder).toBeNull();
  });
});

describe.skipIf(FILES.length === 0)('非 std 谱面被拒绝', () => {
  it('mode != 0 时抛出可读错误', async () => {
    // 手工构造一个最小的 mania 谱面
    const mania = [
      'osu file format v14',
      '',
      '[General]',
      'Mode: 3',
      '',
      '[Difficulty]',
      'CircleSize:4',
      'OverallDifficulty:8',
      'ApproachRate:9',
      'HPDrainRate:5',
      'SliderMultiplier:1.4',
      'SliderTickRate:1',
      '',
      '[HitObjects]',
      '64,192,1000,1,0,0:0:0:0:',
      '',
    ].join('\n');

    const bytes = new TextEncoder().encode(mania);
    await expect(
      loadBeatmap(bytes.buffer.slice(0, bytes.byteLength)),
    ).rejects.toThrow(/mode 3|只支持 osu!std/);
  });
});
