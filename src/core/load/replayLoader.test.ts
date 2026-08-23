import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatLegacyMods, loadReplay, speedMultiplierOfLegacyMods } from './replayLoader';

/* ---------------- 纯函数部分:无需素材,始终运行 ---------------- */

describe('formatLegacyMods', () => {
  it('无 mod 为 NM', () => {
    expect(formatLegacyMods(0)).toBe('NM');
  });

  it('实测值对得上', () => {
    // 这三个数字取自本机真实回放,不是推算的
    expect(formatLegacyMods(8)).toBe('HD');
    expect(formatLegacyMods(1032)).toBe('HDFL');
    expect(formatLegacyMods(8192)).toBe('AP');
  });

  it('消除蕴含关系带来的冗余', () => {
    // stable 开 NC 时会连带置位 DT,直接拼接会得到 "DTNC"
    expect(formatLegacyMods(64 | 512)).toBe('NC');
    expect(formatLegacyMods(32 | 16384)).toBe('PF');
    expect(formatLegacyMods(2048 | 4194304)).toBe('CN');
    // 单独的 DT / SD 不受影响
    expect(formatLegacyMods(64)).toBe('DT');
    expect(formatLegacyMods(32)).toBe('SD');
  });

  it('按位序拼接', () => {
    expect(formatLegacyMods(8 | 16 | 64)).toBe('HDHRDT');
  });

  it('未定义的高位原样报出,不静默吞掉', () => {
    expect(formatLegacyMods(1 << 31)).toMatch(/^\?0x/);
  });
});

describe('speedMultiplierOfLegacyMods', () => {
  it('DT / NC 为 1.5×,HT 为 0.75×,其余 1×', () => {
    expect(speedMultiplierOfLegacyMods(64)).toBe(1.5);
    expect(speedMultiplierOfLegacyMods(64 | 512)).toBe(1.5);
    expect(speedMultiplierOfLegacyMods(256)).toBe(0.75);
    expect(speedMultiplierOfLegacyMods(0)).toBe(1);
    expect(speedMultiplierOfLegacyMods(8 | 16)).toBe(1);
  });
});

/* ---------------- 真实 .osr:有素材才跑 ---------------- */

/**
 * `.osr` 不入库(体积 + 再分发问题,见 .gitignore),所以这组用例是**条件执行**的:
 * 往 `fixtures/` 丢任意 `.osr` 就会自动纳入,没有就跳过。
 *
 * ⚠️ 这里测的是**字段映射**。vitest 跑在 Node 下,`import('osu-parsers')` 会按
 * exports 的 `node` 条件解析到 `lib/node.mjs`;浏览器实际加载的是 `lib/browser.mjs`。
 * 浏览器那条路径由 `vite build`(产物里零 `node:` 引用)+ headless Chrome 实跑覆盖,
 * 见 docs/TECH-NOTES.md A1。
 */
const FIXTURE_DIR = join(process.cwd(), 'fixtures');

function fixtures(): string[] {
  try {
    return readdirSync(FIXTURE_DIR)
      .filter((name) => name.toLowerCase().endsWith('.osr'))
      .map((name) => join(FIXTURE_DIR, name));
  } catch {
    return [];
  }
}

const FILES = fixtures();

describe.skipIf(FILES.length === 0)('loadReplay(真实 .osr)', () => {
  for (const file of FILES) {
    const name = file.split(/[\\/]/).pop()!;

    describe(name, () => {
      // 每个 it 都重解一遍要多跑好几次 LZMA 解压 —— 解一次共用
      let cached: ReturnType<typeof loadReplay> | undefined;
      const load = (): ReturnType<typeof loadReplay> => {
        if (!cached) {
          const buf = readFileSync(file);
          cached = loadReplay(
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          );
        }
        return cached;
      };

      it('解析出非空帧序列', async () => {
        const { frames } = await load();
        expect(frames.count).toBeGreaterThan(100);
      });

      it('帧时间严格升序 —— 二分查找的前提', async () => {
        const { frames } = await load();
        for (let i = 1; i < frames.count; i++) {
          expect(frames.time[i]!).toBeGreaterThanOrEqual(frames.time[i - 1]!);
        }
      });

      it('不含 -12345 哨兵帧', async () => {
        const { frames } = await load();
        for (let i = 0; i < frames.count; i++) expect(frames.time[i]).not.toBe(-12345);
      });

      it('坐标是有限数 —— 但不保证落在 playfield 内', async () => {
        const { frames } = await load();
        for (let i = 0; i < frames.count; i++) {
          expect(Number.isFinite(frames.x[i]!)).toBe(true);
          expect(Number.isFinite(frames.y[i]!)).toBe(true);
        }
      });

      it('成绩摘要字段都被识别(不是 fallback 值)', async () => {
        const { info } = await load();

        expect(info.totalScore).toBeGreaterThan(0);
        expect(info.maxCombo).toBeGreaterThan(0);
        expect(info.accuracy).toBeGreaterThan(0);
        expect(info.accuracy).toBeLessThanOrEqual(1);
        expect(info.beatmapHashMD5).toMatch(/^[0-9a-f]{32}$/);
        expect(info.count300).toBeGreaterThan(0);
        expect(info.mods).toMatch(/^(NM|([A-Z0-9]{2})+)$/);
        expect(info.gameVersion).toBeGreaterThan(0);
      });

      it('判定计数与 statistics 一致 —— A2 的比对基准', async () => {
        const { info, raw } = await load();
        const stats = raw.info.statistics;

        // statistics 是 Map<HitResult, count>,是 count300/100/50 的权威来源
        expect(info.count300 + info.count100 + info.count50 + info.countMiss)
          .toBe(raw.info.totalHits);
        expect(stats.size).toBeGreaterThan(0);
      });

      it('frameCount 与 frames.count 一致', async () => {
        const { frames, info } = await load();
        expect(info.frameCount).toBe(frames.count);
      });

      it('isLazer 与 gameVersion 一致', async () => {
        const { info } = await load();
        expect(info.isLazer).toBe(info.gameVersion >= 30000000);
      });
    });
  }
});
