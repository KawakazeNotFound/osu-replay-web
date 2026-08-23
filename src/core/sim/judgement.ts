import { normalizeKeys, type ReplayFrames } from '../replay/frames';
import { MISS_WINDOW, hitWindowsFromOD, radiusFromCS, type HitWindows } from './difficulty';
import type { JudgementPass } from './timeline';
import {
  HitResult,
  ZERO_CUMULATIVE,
  type CumulativeState,
  type JudgementEvent,
  type JudgementPart,
  type ObjectResult,
  type SimBeatmap,
  type SimHitObject,
} from './types';

/**
 * circle 判定。
 *
 * ## 来源
 *
 * 对照 `ppy/osu` master(2026-08-23 核对):
 * - `osu.Game.Rulesets.Osu/Objects/Drawables/DrawableHitCircle.cs` → `CheckForResult`
 * - `osu.Game.Rulesets.Osu/UI/LegacyHitPolicy.cs` → `CheckHittable`(stable 的 notelock)
 * - `osu.Game/Rulesets/Scoring/HitWindows.cs` → `ResultFor` / `CanBeHit`
 *
 * ## 三个容易搞错的地方
 *
 * 1. **自动 miss 的阈值是 `meh` 窗口,不是 400ms。**
 *    `CanBeHit(timeOffset) => timeOffset <= WindowFor(最低成功判定)`,即 meh 窗口,
 *    且**不取绝对值**(所以提早任意多都不会自动 miss,只有过晚才会)。
 *    400ms 的 `MISS_WINDOW` 只是 hit policy 的 `hittableRange`。
 *
 * 2. **在 `(meh, 400]` 区间内点击会判出 `Miss` 并消耗该物件。**
 *    `ResultFor` 在该区间返回 `Miss`(一个真判定),超过 400 才返回 `None`(无判定)。
 *    这就是 stable 里"点早了吃 miss"的来源。
 *
 * 3. **`ResultFor` 先取绝对值,比较用 `<=`。** 与 `hitWindowsFromOD` 的
 *    `floor(x) - 0.5` 配合:OD 8 的 great 窗口是 31.5,偏差 31 算 300、32 不算。
 *
 * ## 已知未建模的部分
 *
 * - **滑条的刻度 / repeat / 尾**:只判**滑条头**(它与 circle 同规则:同样的
 *   命中窗口、同样的圆形命中区)。刻度与尾是 M2。因此:
 *   - 滑条头会**正确消耗按下**,这一点是必须的(见下)
 *   - 滑条头计入 **combo**,但**不计入** 300/100/50 计数 —— stable 里整条滑条
 *     只产生一个 300/100/50,取决于命中了多少个部件,那要等刻度实现
 * - **`LegacyHitPolicy` 的 stack-Ignore 分支**:当前一个 alive 物件
 *   `StackHeight > 0` 且未判定时,lazer 会把这次输入**整个吞掉**(`ClickAction.Ignore`)。
 *   这里没建模。
 * - **转盘**:不消耗按下(转盘是转的,不是点的),也不产生判定。
 * - **lazer 的 `ObjectOrderedHitPolicy`**:lazer 默认策略与 stable 不同。
 *   这里实现的是 stable 的 `LegacyHitPolicy`。lazer 回放要另做,见 M5。
 *
 * ## 为什么必须判滑条头 —— 一个实测教训
 *
 * 最初的版本完全跳过滑条,以为"circle 部分至少是对的"。**错了。**
 *
 * 实测 `stable.osr`(FC,全图 0 miss)却被判出 1 个 circle miss。挖出来是:
 * 滑条在 155841、circle 在 156169;玩家在 155836 按下(那是给滑条头的),
 * 但滑条不参与判定,于是这次按下"漏"到了 333ms 后的 circle 上 —— 距离
 * 32.0 落在半径 36.49 内,而 333ms 落在 `(meh, 400]` 区间,
 * `ResultFor` 返回 `Miss` 并**消耗掉**那个 circle。
 *
 * 所以"跳过滑条"不是部分实现,是主动引入错误:**按下必须被正确的物件吃掉**。
 */

/** hit policy 的可点击时间范围。lazer 的 `hittableRange` 默认 = `MISS_WINDOW`。 */
const HITTABLE_RANGE = MISS_WINDOW;

/**
 * notelock 的额外宽容(ms)。
 *
 * lazer 注释:"3ms of extra leniency to account for slightly unsnapped objects" ——
 * 前一个未判定物件只有在**结束得足够早**时才阻挡后一个:
 * `earlier.endTime + 3 < later.startTime`。所以时间上几乎重合的物件不互锁。
 */
const NOTELOCK_LENIENCY = 3;

/**
 * 把偏差映射成判定结果。对应 lazer 的 `HitWindows.ResultFor`。
 *
 * ⚠️ 传入的 delta 会先取绝对值;比较是 `<=`;都落空时返回 `None`(**无判定**,
 * 与 `Miss` 不同 —— 后者是一个真判定,会消耗物件)。
 */
export function resultForOffset(delta: number, windows: HitWindows): HitResult {
  const offset = Math.abs(delta);

  // lazer 从最严的判定往下找,返回第一个命中的
  if (offset <= windows.great) return HitResult.Great;
  if (offset <= windows.ok) return HitResult.Ok;
  if (offset <= windows.meh) return HitResult.Meh;
  if (offset <= windows.miss) return HitResult.Miss;
  return HitResult.None;
}

/**
 * 物件能否还能被判定(未过期)。对应 lazer 的 `HitWindows.CanBeHit`。
 *
 * ⚠️ 传入的是**带符号**的 timeOffset,且阈值是 **meh 窗口**。
 * 提早任意多都为 true(负数天然 `<=`),只有过晚才 false。
 */
export function canStillBeHit(timeOffset: number, windows: HitWindows): boolean {
  return timeOffset <= windows.meh;
}

/** 一次按键按下事件。 */
interface Press {
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

/**
 * 从回放帧里提取"按下"边沿。
 *
 * 只取**新增**的按键位:上一帧没按、这一帧按了。同一帧内两个键同时新按下算两次
 * (lazer 里每个键各自触发一次 action)。
 *
 * ⚠️ 用帧自身的坐标,**不插值** —— 按下发生在某个具体帧上,插值会得到一个
 * 玩家从未处于过的位置。
 */
export function extractPresses(frames: ReplayFrames): Press[] {
  const presses: Press[] = [];
  let previous = 0;

  for (let i = 0; i < frames.count; i++) {
    const current = normalizeKeys(frames.keys[i]!);
    const pressed = current & ~previous;

    // 逐位处理:两个键同时新按下 → 两次 press
    for (let bit = 1; bit <= 2; bit <<= 1) {
      if (pressed & bit) {
        presses.push({ time: frames.time[i]!, x: frames.x[i]!, y: frames.y[i]! });
      }
    }

    previous = current;
  }

  return presses;
}

export interface CircleJudgementOptions {
  /**
   * 是否把转盘也当成可点击物件。默认 `false`。
   *
   * 转盘是转的不是点的,正常不该消耗按下。这个开关只为测试保留。
   */
  readonly spinnersConsumePresses?: boolean;
}

/**
 * 建一个判定器(circle + 滑条头),可直接传给 `buildTimeline({ judge })`。
 */
export function createCircleJudgement(
  options: CircleJudgementOptions = {},
): JudgementPass {
  return (beatmap, frames) => judgeCircles(beatmap, frames, options);
}

function judgeCircles(
  beatmap: SimBeatmap,
  frames: ReplayFrames,
  options: CircleJudgementOptions,
): { events: JudgementEvent[]; objectResults: (ObjectResult | null)[] } {
  const objects = beatmap.hitObjects;
  const n = objects.length;

  const windows = hitWindowsFromOD(beatmap.difficulty.overallDifficulty);
  const radius = radiusFromCS(beatmap.difficulty.circleSize);

  const objectResults = new Array<ObjectResult | null>(n).fill(null);

  /** 头部是否已被吃掉(circle 是整体,slider 是头)。防止同一物件被点两次。 */
  const headConsumed = new Uint8Array(n);

  /**
   * 物件"完全判定完成"的时刻 —— notelock 判断用的就是这个。
   *
   * ⚠️ 这是一处**实测踩出来的关键区分**:
   * - circle:解析于它自己的判定时刻(命中时刻或过期时刻)
   * - **slider / spinner:解析于 `endTime`**,与头部何时被命中无关
   *
   * 因为 lazer 的 `AllJudged` 要求所有嵌套部件(头/刻度/尾)都判完,而那是在
   * 滑条结束时才发生。若把滑条在"头命中"时就当作判完,滑动过程中的按下就会
   * 漏到后面的 circle 上并把它判成 Miss —— 实测在 FC 回放上制造出了不存在的 miss。
   */
  const resolveTime = new Float64Array(n).fill(Number.POSITIVE_INFINITY);

  /**
   * 参与"吃按下"的物件:circle 与 slider(后者按其头部判定)。
   *
   * 转盘默认不参与 —— 见 `spinnersConsumePresses`。
   */
  const judgeable = (o: SimHitObject): boolean =>
    o.kind === 'circle' ||
    o.kind === 'slider' ||
    (o.kind === 'spinner' && options.spinnersConsumePresses === true);

  for (let i = 0; i < n; i++) {
    const o = objects[i]!;
    // 滑条与转盘的解析时刻是已知的(endTime),不依赖玩家操作
    if (o.kind !== 'circle') resolveTime[i] = o.endTime;
    // 不参与判定的物件头部直接标记为已吃,免得参与候选扫描
    if (!judgeable(o)) headConsumed[i] = 1;
  }

  /** 判定结果的时间线。先收集,最后统一排序 + 累积。 */
  const raw: {
    time: number;
    objectIndex: number;
    result: HitResult;
    part: JudgementPart;
  }[] = [];

  /**
   * 最早一个"可能尚未解析"的物件下标。
   *
   * 只在队首物件已解析时前进 —— 未解析的物件必须留在扫描范围内,
   * 因为它们正是能阻挡后续物件的那些。
   */
  let scanStart = 0;
  const advanceScan = (t: number): void => {
    while (scanStart < n && resolveTime[scanStart]! <= t) scanStart++;
  };

  /** circle → `'circle'`;slider → `'sliderHead'`。这决定它是否计入 300/100/50。 */
  const partOf = (kind: SimHitObject['kind']): JudgementPart =>
    kind === 'slider' ? 'sliderHead' : kind === 'spinner' ? 'spinner' : 'circle';

  const apply = (index: number, time: number, result: HitResult): void => {
    const o = objects[index]!;
    headConsumed[index] = 1;

    // circle 在判定时刻解析;slider / spinner 仍按 endTime(已预设),不要覆盖
    if (o.kind === 'circle') resolveTime[index] = time;

    objectResults[index] = {
      objectIndex: index,
      result,
      hitTime: result === HitResult.Miss ? null : time,
    };
    raw.push({ time, objectIndex: index, result, part: partOf(o.kind) });
  };

  /**
   * 让所有"已经过了 meh 窗口"仍未被吃的头 miss。
   *
   * 因为物件按 startTime 升序,过期时刻也升序,所以扫到第一个未过期的即可停。
   */
  const expireUpTo = (t: number): void => {
    for (let i = scanStart; i < n; i++) {
      if (headConsumed[i] === 1) continue;

      const start = objects[i]!.startTime;
      // canStillBeHit 用带符号偏差:t - startTime > meh 才过期
      if (canStillBeHit(t - start, windows)) break;

      apply(i, start + windows.meh, HitResult.Miss);
    }
    advanceScan(t);
  };

  for (const press of extractPresses(frames)) {
    expireUpTo(press.time);

    for (let i = scanStart; i < n; i++) {
      if (headConsumed[i] === 1) continue;
      const o = objects[i]!;

      // notelock(LegacyHitPolicy 的顺序扫描):更早且**尚未解析**的物件,
      // 若"结束得足够早",就阻挡这一个,连带阻挡它之后的所有物件
      if (blockedByEarlier(objects, resolveTime, scanStart, i, press.time)) break;

      // hit policy 的时间闸门:|startTime - time| < hittableRange
      const gap = o.startTime - press.time;
      if (Math.abs(gap) >= HITTABLE_RANGE) {
        // 物件还在未来且已超出范围 → 后面的更远,直接停
        if (gap > 0) break;
        continue;
      }

      // 光标是否落在圈内。lazer 用的是 drawable 空间的 hover 检测,
      // 其命中形状等价于以 StackedPosition 为心、radius 为半径的圆。
      if (!withinCircle(press.x, press.y, o.stackedX, o.stackedY, radius)) continue;

      const result = resultForOffset(press.time - o.startTime, windows);
      // None 表示"无判定" —— 这次按下对该物件不产生任何结果,但可以继续看下一个
      if (result === HitResult.None) continue;

      apply(i, press.time, result);
      advanceScan(press.time);
      break; // 一次按下最多判定一个物件
    }
  }

  // 回放结束后仍未被吃的头全部 miss
  for (let i = 0; i < n; i++) {
    if (headConsumed[i] === 1) continue;
    apply(i, objects[i]!.startTime + windows.meh, HitResult.Miss);
  }

  return { events: accumulate(raw), objectResults };
}

/**
 * notelock 的顺序判断。
 *
 * lazer `LegacyHitPolicy` 的规则:遍历 alive 物件,跳过**已完全判定**的;
 * 遇到被测物件就停;其余未判定物件**只有在 `endTime + 3 < 被测物件.startTime`
 * 时**才阻挡。所以时间上几乎重合的物件不互锁(3ms 宽容)。
 *
 * "已完全判定"用 `resolveTime <= pressTime` 判断 —— 滑条要到 `endTime` 才算,
 * 见 `resolveTime` 的注释。
 */
function blockedByEarlier(
  objects: readonly SimHitObject[],
  resolveTime: Float64Array,
  from: number,
  target: number,
  pressTime: number,
): boolean {
  const targetStart = objects[target]!.startTime;

  for (let j = from; j < target; j++) {
    if (resolveTime[j]! <= pressTime) continue; // 已完全判定
    if (objects[j]!.endTime + NOTELOCK_LENIENCY < targetStart) return true;
  }
  return false;
}

/** 光标是否落在圈内。边界算命中(与 lazer 的 `<=` 语义一致)。 */
function withinCircle(
  cursorX: number,
  cursorY: number,
  centerX: number,
  centerY: number,
  radius: number,
): boolean {
  const dx = cursorX - centerX;
  const dy = cursorY - centerY;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * 把散落的判定结果排序并累积成 `JudgementEvent[]`。
 *
 * `buildTimeline` 要求事件按时间升序,且每个事件的 `cum` 是该事件**生效后**的
 * 累积状态 —— 这是 `stateAt` 能 O(log n) 的全部原因。
 */
function accumulate(
  raw: readonly {
    time: number;
    objectIndex: number;
    result: HitResult;
    part: JudgementPart;
  }[],
): JudgementEvent[] {
  // 同一时刻的多个判定按物件下标稳定排序,保证可复现
  const sorted = [...raw].sort((a, b) => a.time - b.time || a.objectIndex - b.objectIndex);

  const events: JudgementEvent[] = [];
  let cum: CumulativeState = ZERO_CUMULATIVE;

  for (const r of sorted) {
    cum = applyToCumulative(cum, r.result, r.part);
    events.push({
      time: r.time,
      objectIndex: r.objectIndex,
      part: r.part,
      result: r.result,
      cum,
    });
  }

  return events;
}

/**
 * 单条判定对累积状态的影响。
 *
 * **combo** 对 circle 与滑条头都递增(osu 里命中滑条头就 +1 combo)。
 *
 * **300/100/50 计数**只算 `part === 'circle'`。原因:stable 里整条滑条只产生
 * **一个** 300/100/50,取决于命中了多少个部件(头/刻度/repeat/尾),
 * 而刻度与尾尚未实现。把滑条头当成 300 会让准确率虚高。
 *
 * ⚠️ `score` 是**占位实现**(基础分之和,无 combo 加成、无难度系数)。
 * stable 的真实公式是 `基础分 + 基础分 * (combo - 1) * 难度系数 / 25`,
 * 难度系数由 HP+CS+OD 之和推出 —— 需要另核源码,尚未做。
 *
 * HP 变化也未实现,见 TECH-NOTES D1。
 */
function applyToCumulative(
  previous: CumulativeState,
  result: HitResult,
  part: JudgementPart,
): CumulativeState {
  const isMiss = result === HitResult.Miss;
  const combo = isMiss ? 0 : previous.combo + 1;

  // 只有 circle 计入 300/100/50 —— 滑条整体判定要等刻度实现
  const counts = part === 'circle';

  return {
    score: previous.score + baseScoreOf(result),
    combo,
    maxCombo: Math.max(previous.maxCombo, combo),
    countGreat: previous.countGreat + (counts && result === HitResult.Great ? 1 : 0),
    countOk: previous.countOk + (counts && result === HitResult.Ok ? 1 : 0),
    countMeh: previous.countMeh + (counts && result === HitResult.Meh ? 1 : 0),
    countMiss: previous.countMiss + (counts && isMiss ? 1 : 0),
    // HP 变化尚未实现(见 TECH-NOTES D1),先原样带过
    hp: previous.hp,
  };
}

/** 判定的基础分。stable:300 / 100 / 50 / 0。 */
function baseScoreOf(result: HitResult): number {
  switch (result) {
    case HitResult.Great:
      return 300;
    case HitResult.Ok:
      return 100;
    case HitResult.Meh:
      return 50;
    default:
      return 0;
  }
}
