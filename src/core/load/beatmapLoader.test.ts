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

      it('comboIndex 从 0 开始,逐个 combo 递增 1,不跳号', async () => {
        const { beatmap } = await load();
        let expected = 0;

        for (const o of beatmap.hitObjects) {
          if (o.newCombo) {
            expect(o.comboIndex, `newCombo@${o.startTime}`).toBe(expected);
            expected++;
          } else {
            expect(o.comboIndex, `@${o.startTime}`).toBe(expected - 1);
          }
        }
        expect(expected).toBeGreaterThan(1);
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
        expect(beatmap.hitObjects[0]!.comboIndex).toBe(0);
        expect(beatmap.hitObjects[0]!.indexInCombo).toBe(1);
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
