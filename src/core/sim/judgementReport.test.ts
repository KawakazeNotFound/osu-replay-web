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
        judge: createCircleJudgement(),
      });

      const objects = bm.beatmap.hitObjects;
      const circles = objects.filter((o) => o.kind === 'circle').length;
      const sliders = objects.filter((o) => o.kind === 'slider').length;
      const spinners = objects.filter((o) => o.kind === 'spinner').length;

      // 仅 circle 的判定(权威计数,与 .osr 的 300/100/50 同口径)
      const circleOnly = { great: 0, ok: 0, meh: 0, miss: 0 };
      // 滑条头的判定(计 combo,不计 300/100/50)
      const heads = { great: 0, ok: 0, meh: 0, miss: 0 };

      for (const e of timeline.events) {
        const bucket = e.part === 'circle' ? circleOnly : e.part === 'sliderHead' ? heads : null;
        if (!bucket) continue;
        if (e.result === HitResult.Great) bucket.great++;
        else if (e.result === HitResult.Ok) bucket.ok++;
        else if (e.result === HitResult.Meh) bucket.meh++;
        else if (e.result === HitResult.Miss) bucket.miss++;
      }

      const real = rp.info;
      const cum = timeline.events.at(-1)?.cum;
      const realTotal = real.count300 + real.count100 + real.count50 + real.countMiss;
      const circleTotal = circleOnly.great + circleOnly.ok + circleOnly.meh + circleOnly.miss;

      lines.push(`\n=== ${name} (${real.isLazer ? 'lazer' : 'stable'}, mods ${real.mods}) ===`);
      lines.push(`  谱面: ${objects.length} 物件 = circle ${circles} + slider ${sliders} + spinner ${spinners}`);
      lines.push(`  OD ${bm.beatmap.difficulty.overallDifficulty.toFixed(2)} CS ${bm.beatmap.difficulty.circleSize.toFixed(2)}`);
      lines.push('');
      lines.push(`                    300      100      50     miss    合计`);
      lines.push(`  .osr 头部(全图)${pad(real.count300)} ${pad(real.count100)} ${pad(real.count50)} ${pad(real.countMiss)}  ${pad(realTotal)}`);
      lines.push(`  我们 circle    ${pad(circleOnly.great)} ${pad(circleOnly.ok)} ${pad(circleOnly.meh)} ${pad(circleOnly.miss)}  ${pad(circleTotal)}`);
      lines.push(`  我们 滑条头    ${pad(heads.great)} ${pad(heads.ok)} ${pad(heads.meh)} ${pad(heads.miss)}  ${pad(heads.great + heads.ok + heads.meh + heads.miss)}`);
      lines.push('');
      lines.push(`  circle 数 == 我们的 circle 判定数: ${
        circleTotal === circles ? '✅' : `❌ ${circleTotal} vs ${circles}`}`);
      lines.push(`  滑条数 == 我们的滑条头判定数: ${
        heads.great + heads.ok + heads.meh + heads.miss === sliders ? '✅' : '❌'}`);
      lines.push('');
      lines.push(`  === 关键判据:circle 的 miss 数 ===`);
      lines.push(`  我们判出的 circle miss: ${circleOnly.miss}`);
      lines.push(`  .osr 全图 miss(含滑条/转盘): ${real.countMiss}`);
      lines.push(`  ${circleOnly.miss > real.countMiss
        ? `❌ 多出 ${circleOnly.miss - real.countMiss} 个 —— 全图 miss 是上界,circle 不可能超过它`
        : '✅ 未超过上界'}`);
      lines.push('');
      lines.push(`  maxCombo: .osr ${real.maxCombo}  vs  我们 ${cum?.maxCombo ?? 0}` +
        `  (我们缺滑条刻度/repeat/尾,必然偏小)`);
    }

    console.log(lines.join('\n'));
  });
});

function pad(n: number): string {
  return String(n).padStart(7);
}
