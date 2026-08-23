import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { loadBeatmap } from '../load/beatmapLoader';
import { loadReplay } from '../load/replayLoader';
import { createCircleJudgement } from './judgement';
import { buildTimeline } from './timeline';
import { HitResult } from './types';

/**
 * 诊断报告(不是断言测试)。
 *
 * 目的:把"我们模拟出来的 circle 判定"与 `.osr` 头部成绩摊开对比,量出差距。
 * 因为 M1 只判 circle、滑条与转盘未实现,**总数必然对不上** ——
 * 这里要看的是差额能否被"未实现的部分"完全解释。
 *
 * 这个文件永远通过(只打印),真正的断言在 `judgementAccuracy.test.ts` 的 L3。
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

describe.skipIf(AVAILABLE.length === 0)('判定复现差距报告', () => {
  it('打印各样本的差距', async () => {
    const lines: string[] = [];

    for (const name of AVAILABLE) {
      const [bm, rp] = await Promise.all([
        loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`))),
        loadReplay(read(join(FIXTURE_DIR, `${name}.osr`))),
      ]);
      const timeline = buildTimeline(bm.beatmap, rp.frames, {
        judge: createCircleJudgement({
          // 两种记分的滑条计数口径不同,见 judgement.ts 的 SliderScoring
          sliderScoring: rp.info.isLazer ? 'lazer' : 'stable',
        }),
      });

      const objects = bm.beatmap.hitObjects;
      const circles = objects.filter((o) => o.kind === 'circle').length;
      const sliders = objects.filter((o) => o.kind === 'slider').length;
      const spinners = objects.filter((o) => o.kind === 'spinner').length;

      const real = rp.info;
      const cum = timeline.events.at(-1)?.cum;
      const realTotal = real.count300 + real.count100 + real.count50 + real.countMiss;
      const simTotal =
        (cum?.countGreat ?? 0) + (cum?.countOk ?? 0) + (cum?.countMeh ?? 0) + (cum?.countMiss ?? 0);

      // 滑条部件的命中情况
      const parts = { tick: [0, 0], repeat: [0, 0], tail: [0, 0] } as Record<
        string,
        [number, number]
      >;
      for (const e of timeline.events) {
        const bucket =
          e.part === 'sliderTick' ? 'tick'
          : e.part === 'sliderRepeat' ? 'repeat'
          : e.part === 'sliderTail' ? 'tail'
          : null;
        if (!bucket) continue;
        parts[bucket]![1]++;
        if (e.result !== HitResult.Miss) parts[bucket]![0]++;
      }

      lines.push(`\n=== ${name} (${real.isLazer ? 'lazer' : 'stable'}, mods ${real.mods}) ===`);
      lines.push(`  谱面: ${objects.length} 物件 = circle ${circles} + slider ${sliders} + spinner ${spinners}`);
      lines.push('');
      lines.push(`                    300      100      50     miss    合计`);
      lines.push(`  .osr 头部     ${pad(real.count300)} ${pad(real.count100)} ${pad(real.count50)} ${pad(real.countMiss)}  ${pad(realTotal)}`);
      lines.push(`  我们模拟      ${pad(cum?.countGreat ?? 0)} ${pad(cum?.countOk ?? 0)} ${pad(cum?.countMeh ?? 0)} ${pad(cum?.countMiss ?? 0)}  ${pad(simTotal)}`);
      lines.push(`  差            ${pad(real.count300 - (cum?.countGreat ?? 0))} ${pad(real.count100 - (cum?.countOk ?? 0))} ${pad(real.count50 - (cum?.countMeh ?? 0))} ${pad(real.countMiss - (cum?.countMiss ?? 0))}  ${pad(realTotal - simTotal)}`);
      lines.push('');
      const exact =
        real.count300 === cum?.countGreat &&
        real.count100 === cum?.countOk &&
        real.count50 === cum?.countMeh &&
        real.countMiss === cum?.countMiss;
      lines.push(`  ${exact ? '✅ 判定计数完全一致!' : '⚠️ 仍有差异'}`);
      lines.push('');
      lines.push(`  滑条部件命中率: 刻度 ${parts.tick![0]}/${parts.tick![1]}` +
        `  repeat ${parts.repeat![0]}/${parts.repeat![1]}` +
        `  末端 ${parts.tail![0]}/${parts.tail![1]}`);
      lines.push(`  maxCombo: .osr ${real.maxCombo}  vs  我们 ${cum?.maxCombo ?? 0}` +
        `  ${real.maxCombo === cum?.maxCombo ? '✅ 一致' : `(差 ${real.maxCombo - (cum?.maxCombo ?? 0)})`}`);
      lines.push(`  准确率: .osr ${(real.accuracy * 100).toFixed(2)}%` +
        `  vs  我们 ${(accuracyOf(cum) * 100).toFixed(2)}%`);
    }

    console.log(lines.join('\n'));
  });
});

function pad(n: number): string {
  return String(n).padStart(7);
}

/** 与 `query.ts` 的 `accuracyOf` 同公式,这里独立算一份免得循环依赖。 */
function accuracyOf(cum: { countGreat: number; countOk: number; countMeh: number; countMiss: number } | undefined): number {
  if (!cum) return 0;
  const hits = cum.countGreat + cum.countOk + cum.countMeh + cum.countMiss;
  if (hits === 0) return 1;
  return (300 * cum.countGreat + 100 * cum.countOk + 50 * cum.countMeh) / (300 * hits);
}
