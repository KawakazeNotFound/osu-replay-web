import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { loadBeatmap } from '../load/beatmapLoader';
import { loadReplay } from '../load/replayLoader';
import { createCircleJudgement } from './judgement';
import { buildTimeline } from './timeline';
import { HitResult } from './types';

/**
 * D13 专用诊断:**列出每一次 combo 归零的时刻与对应物件**。
 *
 * 背景(TECH-NOTES D13):`stable.osr` 的判定计数只差 1 个,准确率只差 0.11%,
 * 但 maxCombo 只有 412 而头部记的是 1151。判定几乎全对而 combo 断了 ——
 * 说明有**极少数**滑条部件被误判成 miss,每一次都把 combo 归零。
 *
 * 只看总数看不出是哪几个。这个文件把每次断连的**物件下标、部件类型、
 * 断连前的 combo** 全打出来,才有得查。
 *
 * 永远通过(只打印)。
 */

const FIXTURE_DIR = join(process.cwd(), 'fixtures');
const NAMES = ['stable', 'stable-hdfl', 'lazer', 'lazer-moonlight'];
const AVAILABLE = NAMES.filter(
  (n) => existsSync(join(FIXTURE_DIR, `${n}.osu`)) && existsSync(join(FIXTURE_DIR, `${n}.osr`)),
);

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe.skipIf(AVAILABLE.length === 0)('D13 combo 断连诊断', () => {
  it('列出每次 combo 归零的物件', async () => {
    const lines: string[] = [];

    for (const name of AVAILABLE) {
      const [bm, rp] = await Promise.all([
        loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`))),
        loadReplay(read(join(FIXTURE_DIR, `${name}.osr`))),
      ]);
      const timeline = buildTimeline(bm.beatmap, rp.frames, {
        judge: createCircleJudgement({
          sliderScoring: rp.info.isLazer ? 'lazer' : 'stable',
          rawMods: rp.info.rawMods,
        }),
      });

      const breaks: string[] = [];
      let previousCombo = 0;

      for (const e of timeline.events) {
        if (e.result === HitResult.Miss) {
          const o = bm.beatmap.hitObjects[e.objectIndex];
          breaks.push(
            `    combo ${String(previousCombo).padStart(5)} → 0` +
              `  @ ${(e.time / 1000).toFixed(3)}s` +
              `  物件#${e.objectIndex} (${o?.kind ?? '?'})` +
              `  部件 ${e.part}`,
          );
        }
        previousCombo = e.cum.combo;
      }

      // 断连有几十次时全打出来没意义,只看**断在高 combo 上**的那几次 ——
      // 那些才是 maxCombo 缺口的来源
      const bigBreaks = breaks.filter((l) => {
        const m = /combo\s+(\d+)/.exec(l);
        return m !== null && Number(m[1]) >= 50;
      });

      lines.push(`\n=== ${name} ===`);
      lines.push(
        `  头部 maxCombo ${rp.info.maxCombo}  我们 ${timeline.events.at(-1)?.cum.maxCombo ?? 0}` +
          `  断连 ${breaks.length} 次(其中 ${bigBreaks.length} 次断在 combo ≥ 50 处)`,
      );

      // 断在高 combo 处的全列出来;其余的只报数
      for (const l of bigBreaks.slice(0, 25)) lines.push(l);
      if (bigBreaks.length > 25) lines.push(`    …还有 ${bigBreaks.length - 25} 次未列出`);

      // 按部件类型统计,一眼看出是哪类部件在误判
      const byPart = new Map<string, number>();
      for (const e of timeline.events) {
        if (e.result !== HitResult.Miss) continue;
        byPart.set(e.part, (byPart.get(e.part) ?? 0) + 1);
      }
      lines.push(
        `  miss 的部件分布: ${[...byPart].map(([p, n]) => `${p}=${n}`).join('  ') || '(无)'}`,
      );
    }

    console.log(lines.join('\n'));
  });
});
