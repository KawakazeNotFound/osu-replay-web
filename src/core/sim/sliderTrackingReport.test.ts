import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { loadBeatmap } from '../load/beatmapLoader';
import { loadReplay } from '../load/replayLoader';
import { radiusFromCS } from './difficulty';
import { pathOffsetAt, timeProgressToPathProgress } from './sliderPath';
import { FOLLOW_AREA } from './sliderTracking';

/**
 * D13 定位诊断:把**具体某几个滑条**的每一帧跟踪状态摊开。
 *
 * `comboBreakReport` 已经把范围收窄到 `stable.osr` 的物件 #225(末端)与
 * #501(repeat)。这里把这两个滑条在其存续期间的**每一帧**打出来:
 * 光标位置、球位置、距离、当前 follow 半径、按键状态 —— 才能看出到底是
 * 跟踪判断错了,还是规则本身错了。
 *
 * 永远通过(只打印)。改 `TARGETS` 换目标。
 */

const FIXTURE_DIR = join(process.cwd(), 'fixtures');

/** 要摊开看的 (样本, 物件下标)。 */
const TARGETS: ReadonlyArray<readonly [string, number]> = [
  ['stable', 225],
  ['stable', 501],
];

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const HAVE = TARGETS.filter(([name]) =>
  existsSync(join(FIXTURE_DIR, `${name}.osu`)) && existsSync(join(FIXTURE_DIR, `${name}.osr`)),
);

describe.skipIf(HAVE.length === 0)('D13 单个滑条的逐帧跟踪', () => {
  it('摊开目标滑条的每一帧', async () => {
    const lines: string[] = [];

    for (const [name, index] of HAVE) {
      const [bm, rp] = await Promise.all([
        loadBeatmap(read(join(FIXTURE_DIR, `${name}.osu`))),
        loadReplay(read(join(FIXTURE_DIR, `${name}.osr`))),
      ]);

      const object = bm.beatmap.hitObjects[index];
      if (object === undefined || object.kind !== 'slider') {
        lines.push(`\n=== ${name} #${index}:不是滑条(${object?.kind ?? '不存在'}),跳过 ===`);
        continue;
      }

      const radius = radiusFromCS(bm.beatmap.difficulty.circleSize);

      lines.push(`\n=== ${name} 物件 #${index} ===`);
      lines.push(
        `  start ${object.startTime.toFixed(1)}  end ${object.endTime.toFixed(1)}` +
          `  spans ${object.spans}  半径 ${radius.toFixed(2)}` +
          `  follow 半径 ${(radius * FOLLOW_AREA).toFixed(2)}` +
          `  起点(堆叠后) (${object.stackedX.toFixed(1)},${object.stackedY.toFixed(1)})`,
      );
      lines.push(`  部件(${object.parts.length} 个):`);
      for (const p of object.parts) {
        lines.push(`    ${p.kind.padEnd(10)} @ ${p.time.toFixed(1)}  spanIndex ${p.spanIndex}`);
      }

      // 逐帧:只打部件时刻附近的帧,否则几百行看不动
      const partTimes = object.parts.map((p) => p.time);
      const nearPart = (t: number) => partTimes.some((pt) => Math.abs(t - pt) <= 40);

      const f = rp.frames;
      lines.push('');
      lines.push('    时刻     光标(x,y)        球(x,y)       距离   键   在part附近');
      for (let i = 0; i < f.count; i++) {
        const t = f.time[i]!;
        if (t < object.startTime - 60 || t > object.endTime + 60) continue;
        if (!nearPart(t)) continue;

        const timeProgress = (t - object.startTime) / (object.endTime - object.startTime);
        const clamped = timeProgress < 0 ? 0 : timeProgress > 1 ? 1 : timeProgress;
        const pathProgress = timeProgressToPathProgress(clamped, object.spans);
        // path 是**相对起点的偏移**,要加上堆叠后的起点
        const offset = pathOffsetAt(object.path, pathProgress);
        const ballX = object.stackedX + offset.x;
        const ballY = object.stackedY + offset.y;

        const dx = f.x[i]! - ballX;
        const dy = f.y[i]! - ballY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        lines.push(
          `    ${t.toFixed(0).padStart(7)}` +
            `  (${f.x[i]!.toFixed(1).padStart(6)},${f.y[i]!.toFixed(1).padStart(6)})` +
            `  (${ballX.toFixed(1).padStart(6)},${ballY.toFixed(1).padStart(6)})` +
            `  ${dist.toFixed(1).padStart(6)}` +
            `  ${String(f.keys[i]).padStart(3)}` +
            `  ${partTimes.some((pt) => Math.abs(t - pt) <= 8) ? '◀ 就在 part 上' : ''}`,
        );
      }
    }

    console.log(lines.join('\n'));
  });
});
