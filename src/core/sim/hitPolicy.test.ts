import { describe, expect, it } from 'vitest';

import { buildReplayFrames } from '../replay/frames';
import { createCircleJudgement } from './judgement';
import { makeHitObject, makeSimBeatmap } from './testFixtures';
import { HitResult, type SimHitObject } from './types';

/**
 * lazer 的 `StartTimeOrderedHitPolicy` 与 stable 的 `LegacyHitPolicy` 的行为差异。
 *
 * ## 为什么必须用合成用例
 *
 * 实测:换成 lazer 的 policy 后,两个真实 lazer 回放的结果**字节级相同** ——
 * 那两位玩家打得够干净,notelock 的差异从未触发。所以 ground truth **验不出**
 * 这段代码对不对,只能靠按源码规则手工构造的用例来锁。
 *
 * ## 源码规则(`StartTimeOrderedHitPolicy.CheckHittable`)
 *
 * ```csharp
 * // blockingObject = candidate.startTime 之前**最后一个**能阻挡的物件
 * if (!blockingObject.Judged && time < blockingObject.HitObject.StartTime)
 *     return ClickAction.Shake;
 * ```
 * 加上 `HandleHit`:命中后把先前所有未判定物件**强制判 miss**。
 *
 * 而 `hitObjectCanBlockFutureHits` 只有一行 `hitObject is DrawableHitCircle` ——
 * 转盘不阻挡,滑条头算(它继承自 `DrawableHitCircle`)。
 */

/** 造帧。`buildReplayFrames` 的字段名是 `startTime` 而不是 `time`。 */
function framesFrom(
  raw: ReadonlyArray<{ time: number; x: number; y: number; keys: number }>,
): ReturnType<typeof buildReplayFrames> {
  return buildReplayFrames(raw.map((f) => ({ startTime: f.time, x: f.x, y: f.y, keys: f.keys })));
}

/** 两种 policy 各判一遍,便于对照。 */
function judgeBoth(
  objects: readonly SimHitObject[],
  frames: ReturnType<typeof buildReplayFrames>,
) {
  const beatmap = makeSimBeatmap(objects);
  const run = (mode: 'stable' | 'lazer') =>
    createCircleJudgement({ sliderScoring: mode })(beatmap, frames).objectResults;

  return { stable: run('stable'), lazer: run('lazer') };
}

describe('lazer hit policy:阻挡条件是 time < 阻挡物.startTime', () => {
  it('按下早于前一个未判定 circle 的 startTime → 被吞掉,两个物件都不判', () => {
    // 物件 0 在 1000,物件 1 在 1200。在 900 按下(早于物件 0 的 startTime)。
    // 按 lazer 规则:物件 1 的阻挡物是物件 0,900 < 1000 → Shake,这次按下作废
    const objects = [
      makeHitObject({ startTime: 1000, x: 100, y: 100 }),
      makeHitObject({ startTime: 1200, x: 300, y: 300 }),
    ];
    // 光标落在物件 1 上,故意不在物件 0 上 —— 这样若没被阻挡就会判中物件 1
    const frames = framesFrom([
      { time: 800, x: 300, y: 300, keys: 0 },
      { time: 900, x: 300, y: 300, keys: 1 },
    ]);

    const { lazer } = judgeBoth(objects, frames);

    // 物件 1 没被这次按下判定(要么 null,要么最终过期 miss)
    expect(lazer[1]?.result).not.toBe(HitResult.Great);
  });

  it('按下晚于前一个未判定 circle 的 startTime → 放行,且前一个被强制判 miss', () => {
    const objects = [
      makeHitObject({ startTime: 1000, x: 100, y: 100 }),
      makeHitObject({ startTime: 1200, x: 300, y: 300 }),
    ];
    // 在 1200 按下,光标在物件 1 上。1200 >= 物件 0 的 1000 → 不阻挡
    const frames = framesFrom([
      { time: 1100, x: 300, y: 300, keys: 0 },
      { time: 1200, x: 300, y: 300, keys: 1 },
    ]);

    const { lazer } = judgeBoth(objects, frames);

    // 物件 1 精确命中
    expect(lazer[1]?.result).toBe(HitResult.Great);
    // 物件 0 被 HandleHit 强制判 miss
    expect(lazer[0]?.result).toBe(HitResult.Miss);
  });

  it('转盘不阻挡后续物件(hitObjectCanBlockFutureHits 只认 circle)', () => {
    const objects = [
      makeHitObject({ kind: 'spinner', startTime: 500, endTime: 1500 }),
      makeHitObject({ startTime: 1600, x: 300, y: 300 }),
    ];
    // 在 1600 按下 —— 若转盘参与阻挡,这次按下会被它挡住
    const frames = framesFrom([
      { time: 1550, x: 300, y: 300, keys: 0 },
      { time: 1600, x: 300, y: 300, keys: 1 },
    ]);

    const { lazer } = judgeBoth(objects, frames);
    expect(lazer[1]?.result).toBe(HitResult.Great);
  });

  it('相同 startTime 的物件互不阻挡(源码刻意放行,举了 /b/372245)', () => {
    const objects = [
      makeHitObject({ startTime: 1000, x: 100, y: 100 }),
      makeHitObject({ startTime: 1000, x: 300, y: 300 }),
    ];
    // 在 1000 按下,光标在第二个上。两者 startTime 相同 → 不阻挡
    const frames = framesFrom([
      { time: 950, x: 300, y: 300, keys: 0 },
      { time: 1000, x: 300, y: 300, keys: 1 },
    ]);

    const { lazer } = judgeBoth(objects, frames);
    expect(lazer[1]?.result).toBe(HitResult.Great);
  });
});

describe('两种 policy 的可观察差异', () => {
  it('stable 的 3ms 宽容 vs lazer 的 startTime 闸门 —— 存在结果不同的构造', () => {
    // ⚠️ 构造这个用例踩了一次坑:第一版把按下放在 1350,但那时物件 0 已经过了
    // meh 窗口(350ms),`expireUpTo` 先把它判成 miss 了 —— 于是 stable 那边
    // 也不再阻挡,两种 policy 结果相同,区分不出来。
    //
    // 要区分,**两个窗口必须重叠**:按下时刻既要在物件 0 的 meh 窗口内
    // (否则它已过期,不再阻挡),又要在物件 1 的 meh 窗口内(否则只能判 miss)。
    // OD 5 的 meh 窗口是 149.5,所以两个物件间隔必须小于 ~300。
    const objects = [
      makeHitObject({ startTime: 1000, x: 100, y: 100 }),
      makeHitObject({ startTime: 1200, x: 300, y: 300 }),
    ];
    // 1100:距物件 0 只 100ms(未过期,stable 会阻挡);≥ 物件 0 的 startTime
    // (lazer 不阻挡);距物件 1 为 −100(落在 meh 窗口内)
    const frames = framesFrom([
      { time: 1050, x: 300, y: 300, keys: 0 },
      { time: 1100, x: 300, y: 300, keys: 1 },
    ]);

    const { stable, lazer } = judgeBoth(objects, frames);

    // lazer 放行 → 物件 1 拿到一个真判定(不是 miss)
    expect(lazer[1]?.result).not.toBe(HitResult.Miss);
    // 且物件 0 被 HandleHit 强制判 miss
    expect(lazer[0]?.result).toBe(HitResult.Miss);

    // stable 挡住 → 这次按下作废,物件 1 最终只能过期 miss
    expect(stable[1]?.result).toBe(HitResult.Miss);
  });
});
