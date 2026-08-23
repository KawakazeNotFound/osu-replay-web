import { ReplayKey, normalizeKeys, type ReplayFrames } from '../replay/frames';
import { firstIndexAtOrAfter, lastIndexAtOrBefore } from '../util/search';
import { MISS_WINDOW, hitWindowsFromOD, radiusFromCS, type HitWindows } from './difficulty';
import { TAIL_LENIENCY, type SliderPart } from './sliderParts';
import { SliderTracker } from './sliderTracking';
import { judgeSpinner } from './spinner';
import {
  SLIDER_END_SCORE,
  SLIDER_TICK_SCORE,
  scoreIncrementFor,
  stableScoringFor,
  type StableScoringOptions,
} from './stableScoring';
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

/** 判定结果的中间表示。排序与累积之前先收集成这个。 */
interface RawJudgement {
  readonly time: number;
  readonly objectIndex: number;
  readonly result: HitResult;
  readonly part: JudgementPart;
  /**
   * 计入 300/100/50/miss 的结果。`undefined` = 该事件不计数。
   *
   * ⚠️ 与 {@link result} 分开是必须的:combo 由**每个部件**驱动,而
   * 300/100/50 **一个物件只有一个**。滑条尤其如此 —— 见 {@link SliderScoring}。
   */
  readonly counted?: HitResult;
}

/**
 * 滑条整体判定的计数口径。
 *
 * ## 这是实测比对出来的,不是猜的
 *
 * 把我们的判定与 4 个真实 `.osr` 头部逐项对照后发现:
 *
 * **lazer**:`count300/100/50` = circle 的结果 + **滑条头**的结果。
 * `lazer.osr` 上精确吻合(circle 149 great + 头 94 great = 243 = 真实值;
 * 4 + 1 = 5 = 真实值)。原因:lazer 里滑条本身不产生 `Great/Ok/Meh`,
 * 是 `SliderHeadCircle` 产生的;刻度走 `LargeTickHit` 等**另外的** statistics
 * 键,不进 `count300`。
 *
 * **stable**:滑条整体按**命中部件的比例**给一个 300/100/50。
 * `stable.osr` 上"circle + 头"比真实少 14 个 300、多 14 个 100 ——
 * 正是那 14 条"头判得晚但部件全中"的滑条:stable 仍给 300。
 */
export type SliderScoring = 'stable' | 'lazer';

/**
 * stable 的滑条整体判定:按命中部件的比例。
 *
 * 部件 = 头 + 全部刻度 + 全部 repeat + 末端。
 *
 * | 命中比例 | 结果 |
 * |---|---|
 * | 全部 | 300 |
 * | > 1/2 | 100 |
 * | ≥ 1 个 | 50 |
 * | 0 | miss |
 */
export function aggregateSliderResult(hit: number, total: number): HitResult {
  if (total <= 0) return HitResult.Miss;
  if (hit >= total) return HitResult.Great;
  if (hit * 2 > total) return HitResult.Ok;
  if (hit > 0) return HitResult.Meh;
  return HitResult.Miss;
}

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

  /**
   * 滑条整体判定的计数口径。默认 `'stable'`。
   *
   * 载入回放时应按 `info.isLazer` 传入 —— 两者规则不同,见 {@link SliderScoring}。
   */
  readonly sliderScoring?: SliderScoring;

  /**
   * 回放的 legacy mod 位掩码。影响**分数**的 mod 系数(HD ×1.06、DT ×1.12…)。
   *
   * 省略则按无 mod 算 —— 分数会偏低但判定不受影响。
   */
  readonly rawMods?: number;
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
  const raw: RawJudgement[] = [];

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

    // circle 的结果直接计数;滑条头是否计数取决于口径(见 SliderScoring),
    // 在 judgeSliderParts 里统一处理
    raw.push({
      time,
      objectIndex: index,
      result,
      part: partOf(o.kind),
      ...(o.kind === 'circle' ? { counted: result } : {}),
    });
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

  // 滑条部件(刻度 / repeat / 末端)—— 必须在所有头判定完之后,
  // 因为部件判定依赖"滑条头被哪个键命中"
  judgeSliderParts(
    objects,
    frames,
    radius,
    objectResults,
    raw,
    options.sliderScoring ?? 'stable',
  );

  // 转盘 —— 不吃按下,靠转圈数判定,与前面完全独立
  for (let i = 0; i < n; i++) {
    const spinner = objects[i]!;
    if (spinner.kind !== 'spinner') continue;

    const { result } = judgeSpinner(spinner, frames, beatmap.difficulty.overallDifficulty);

    objectResults[i] = {
      objectIndex: i,
      result,
      hitTime: result === HitResult.Miss ? null : spinner.endTime,
    };

    raw.push({
      time: spinner.endTime,
      objectIndex: i,
      result,
      part: 'spinner',
      counted: result,
    });
  }

  return {
    events: accumulate(raw, stableScoringFor(beatmap, options.rawMods ?? 0)),
    objectResults,
  };
}

/**
 * 判定滑条的嵌套部件。
 *
 * 对每条滑条建一个 {@link SliderTracker},按部件时间顺序推进,在各部件的判定
 * 时刻问"此刻是否在跟踪"。规则见 `sliderTracking.ts` 与 TECH-NOTES B15。
 *
 * ## 两处与 lazer 对齐的顺序规则
 *
 * 1. **滑条头未命中则所有部件全 miss。** lazer 的 `TryJudgeNestedObject` 要求
 *    `slider.HeadCircle.Judged`,而且头 miss 时 `HitAction` 为 null → 跟踪键
 *    不受限但玩家通常也没在跟;这里直接短路,结果一致且更明确。
 * 2. **末端(legacyLastTick)有 36ms 提前宽容。** lazer:tail 在
 *    `timeOffset >= TAIL_LENIENCY`(即 `t >= 末端时刻 - 36`)就可以判 ——
 *    所以那 36ms 内**任意一帧**在跟踪都算命中。
 *
 * ## 未建模
 *
 * lazer 的 `PostProcessHeadJudgement`(头命中瞬间"追认"已到时刻的部件)。
 * 它只在"头命中得很晚、部件时刻已过"时才有影响 —— 而那种情况下 tracker 从
 * 头命中时刻开始推进,结论通常相同。若 A2 出现个别滑条差 1,这里是嫌疑点。
 */
function judgeSliderParts(
  objects: readonly SimHitObject[],
  frames: ReplayFrames,
  radius: number,
  objectResults: (ObjectResult | null)[],
  raw: RawJudgement[],
  scoring: SliderScoring,
): void {
  for (let i = 0; i < objects.length; i++) {
    const slider = objects[i]!;
    if (slider.kind !== 'slider') continue;

    const head = objectResults[i];
    const headResult = head?.result ?? HitResult.Miss;
    const headHit = headResult !== HitResult.Miss;

    /** 部件命中数与总数,用于 stable 的比例聚合。头也算一个部件。 */
    let hitParts = headHit ? 1 : 0;
    let totalParts = 1;

    if (slider.parts.length > 0) {
      if (!headHit) {
        // 头没命中 → 所有部件 miss(见函数注释第 1 条)
        for (const part of slider.parts) {
          totalParts++;
          raw.push({
            time: part.time,
            objectIndex: i,
            result: HitResult.Miss,
            part: partNameOf(part.kind),
          });
        }
      } else {
        // 单次前向扫过滑条时间范围内的**每一帧**,顺路记下各部件时刻的跟踪状态。
        //
        // ⚠️ 必须逐帧推进,不能只在部件时刻问一次 —— 跟踪的 follow area 有滞回:
        // 初始 `tracking = false` 用的是**小圈**。真实 osu 是从滑条头开始每帧更新,
        // 在头那里光标就在小圈内,于是"咬住"并切到大圈。
        // 只在部件时刻采样的话,第一个部件常常因为还没咬住而落在小圈外 → 假 miss。
        // (实测:改成逐帧前,stable.osu 的 maxCombo 从 1152 掉到 317)
        const results = trackPartsOverFrames(slider, frames, radius, head?.hitTime ?? null);

        for (let k = 0; k < slider.parts.length; k++) {
          const part = slider.parts[k]!;
          const hit = results[k]!;

          totalParts++;
          if (hit) hitParts++;

          raw.push({
            time: part.time,
            objectIndex: i,
            result: hit ? HitResult.Great : HitResult.Miss,
            part: partNameOf(part.kind),
          });
        }
      }
    }

    // ---- 计数:一个滑条只产生一个 300/100/50/miss ----
    if (scoring === 'lazer') {
      // lazer:滑条头的结果**就是**滑条的 Great/Ok/Meh;刻度走另外的 statistics 键
      markCounted(raw, i, 'sliderHead', headResult);
    } else {
      // stable:按命中部件比例聚合,计在**末端**时刻(那才是结果揭晓的时候)
      const aggregate = aggregateSliderResult(hitParts, totalParts);
      const endPart = slider.parts.at(-1);

      if (endPart) {
        markCounted(raw, i, partNameOf(endPart.kind), aggregate);
      } else {
        // 退化滑条(没有部件):只能按头算
        markCounted(raw, i, 'sliderHead', aggregate);
      }

      // objectResults 反映的是**整体**结果,渲染层要看这个
      objectResults[i] = {
        objectIndex: i,
        result: aggregate,
        hitTime: head?.hitTime ?? null,
      };
    }
  }
}

/**
 * 逐帧跟踪整条滑条,返回每个部件是否命中(与 `slider.parts` 同序)。
 *
 * 一次前向扫描完成所有部件 —— 跟踪状态有滞回,必须连续推进。
 *
 * ## 各部件的判定窗口
 *
 * - 刻度 / repeat:在其时刻**当下**是否在跟踪
 * - **末端有 36ms 提前宽容**:lazer 的 tail 在 `timeOffset >= TAIL_LENIENCY`
 *   (即 `t >= 末端时刻 - 36`)就可以判 —— 所以那 36ms 内**任意一帧**在跟踪都算命中
 *
 * 起点从"滑条头命中时刻"开始(而不是 startTime)—— 头命中之前谈不上跟踪键的限制,
 * 而且 lazer 的嵌套物件判定要求头已判定。
 */
function trackPartsOverFrames(
  slider: SimHitObject,
  frames: ReplayFrames,
  radius: number,
  headHitTime: number | null,
): boolean[] {
  const parts = slider.parts;
  const hit = new Array<boolean>(parts.length).fill(false);
  if (parts.length === 0) return hit;

  const tracker = new SliderTracker(slider, frames, radius);
  tracker.setHeadResult(headKeyOf(frames, headHitTime));

  // 每个部件的判定窗口起点(末端提前 36ms)
  const windowStart = parts.map((p) =>
    p.kind === 'legacyLastTick' ? p.time + TAIL_LENIENCY : p.time,
  );

  const from = headHitTime ?? slider.startTime;
  let index = firstIndexAtOrAfter(frames.time, frames.count, from);

  // 先在起点问一次,让跟踪器有机会在滑条头处"咬住"
  let tracking = tracker.advanceTo(from);
  applyToWindows(hit, parts, windowStart, from, tracking);

  while (index < frames.count && frames.time[index]! <= slider.endTime) {
    const t = frames.time[index]!;
    tracking = tracker.advanceTo(t);
    applyToWindows(hit, parts, windowStart, t, tracking);
    index++;
  }

  // 帧可能不落在部件时刻上,所以每个部件时刻再问一次
  for (let k = 0; k < parts.length; k++) {
    if (hit[k]) continue;
    if (tracker.advanceTo(parts[k]!.time)) hit[k] = true;
  }

  return hit;
}

/** 把某一时刻的跟踪状态记到所有"窗口已开启且时刻未过"的部件上。 */
function applyToWindows(
  hit: boolean[],
  parts: readonly SliderPart[],
  windowStart: readonly number[],
  t: number,
  tracking: boolean,
): void {
  if (!tracking) return;

  for (let k = 0; k < parts.length; k++) {
    if (hit[k]) continue;
    if (t >= windowStart[k]! && t <= parts[k]!.time) hit[k] = true;
  }
}

/**
 * 把某个已收集的判定标记为"计数事件"。
 *
 * `raw` 是数组(元素只读),所以就地替换那一项。找**最后一个**匹配的 ——
 * 一条滑条可能有多个同类部件(多个刻度),末端只有一个。
 */
function markCounted(
  raw: RawJudgement[],
  objectIndex: number,
  part: JudgementPart,
  counted: HitResult,
): void {
  for (let i = raw.length - 1; i >= 0; i--) {
    const entry = raw[i]!;
    if (entry.objectIndex === objectIndex && entry.part === part) {
      raw[i] = { ...entry, counted };
      return;
    }
  }
}

/**
 * 找出命中滑条头的是哪个键。
 *
 * 取命中时刻那一帧按住的键。若两个键同时按住,取 M1 —— lazer 用的是实际触发
 * `OnPressed` 的那个 action,我们从回放帧只能看到"哪些键按住",这是必要的近似。
 */
function headKeyOf(frames: ReplayFrames, hitTime: number | null): number {
  if (hitTime === null) return 0;

  const index = lastIndexAtOrBefore(frames.time, frames.count, hitTime);
  if (index < 0) return 0;

  const keys = normalizeKeys(frames.keys[index]!);
  if (keys & ReplayKey.M1) return ReplayKey.M1;
  if (keys & ReplayKey.M2) return ReplayKey.M2;
  return 0;
}

function partNameOf(kind: SliderPart['kind']): JudgementPart {
  switch (kind) {
    case 'tick':
      return 'sliderTick';
    case 'repeat':
      return 'sliderRepeat';
    case 'legacyLastTick':
      return 'sliderTail';
  }
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
  raw: readonly RawJudgement[],
  scoring: StableScoringOptions,
): JudgementEvent[] {
  // 同一时刻的多个判定按物件下标稳定排序,保证可复现
  const sorted = [...raw].sort((a, b) => a.time - b.time || a.objectIndex - b.objectIndex);

  const events: JudgementEvent[] = [];
  let cum: CumulativeState = ZERO_CUMULATIVE;

  for (const r of sorted) {
    cum = applyToCumulative(cum, r.result, r.counted, r.part, scoring);
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
 * **combo** 由**每个部件**驱动(circle、滑条头、每个刻度 / repeat / 末端)——
 * osu 里命中滑条头 +1、每个刻度 +1、末端 +1;miss 任何一个都断连。
 *
 * **300/100/50 计数**只由带 `counted` 的事件驱动,**一个物件只有一个** ——
 * 口径见 {@link SliderScoring}。
 *
 * ⚠️ `score` 是**占位实现**(基础分之和,无 combo 加成、无难度系数)。
 * 真实公式见 TECH-NOTES B14。
 *
 * HP 变化也未实现,见 TECH-NOTES D1。
 */
function applyToCumulative(
  previous: CumulativeState,
  result: HitResult,
  counted: HitResult | undefined,
  part: JudgementPart,
  scoring: StableScoringOptions,
): CumulativeState {
  const isMiss = result === HitResult.Miss;
  const combo = isMiss ? 0 : previous.combo + 1;

  // 分数用**这次判定之前**的 combo,且 miss 不加分
  const increment = isMiss
    ? 0
    : scoreIncrementFor(
        baseScoreOf(result, part, counted),
        previous.combo,
        affectsComboMultiplier(part, counted),
        scoring,
      );

  return {
    score: previous.score + increment,
    combo,
    maxCombo: Math.max(previous.maxCombo, combo),
    countGreat: previous.countGreat + (counted === HitResult.Great ? 1 : 0),
    countOk: previous.countOk + (counted === HitResult.Ok ? 1 : 0),
    countMeh: previous.countMeh + (counted === HitResult.Meh ? 1 : 0),
    countMiss: previous.countMiss + (counted === HitResult.Miss ? 1 : 0),
    // HP 变化尚未实现(见 TECH-NOTES D1),先原样带过
    hp: previous.hp,
  };
}

/**
 * 该部件的基础分。
 *
 * | 部件 | 基础分 |
 * |---|---|
 * | circle / spinner | 判定值 300/100/50 |
 * | 滑条的**计数**部件(带 `counted`) | 该聚合判定值 |
 * | 滑条头 / repeat / 末端(非计数) | 30 |
 * | 滑条刻度 | 10 |
 *
 * ⚠️ 滑条的整体判定值挂在**带 `counted` 的那个事件**上(stable 是末端、
 * lazer 是头),所以那个事件既算 30 的部件分**也**算整体分 —— 这与
 * `OsuLegacyScoreSimulator` 一致:它对 Slider 本身加 300,对嵌套部件另外加。
 */
function baseScoreOf(
  result: HitResult,
  part: JudgementPart,
  counted: HitResult | undefined,
): number {
  if (part === 'circle' || part === 'spinner') return judgementValue(result);

  // 滑条:计数事件用聚合判定值,其余按部件类型
  if (counted !== undefined) return judgementValue(counted);
  if (part === 'sliderTick') return SLIDER_TICK_SCORE;
  return SLIDER_END_SCORE;
}

/** 判定 → 分值。stable:300 / 100 / 50 / 0。 */
function judgementValue(result: HitResult): number {
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

/**
 * 该部件是否吃 combo 加成。
 *
 * `OsuLegacyScoreSimulator`:只有 HitCircle / Slider / Spinner 吃 ——
 * 滑条的嵌套部件(刻度 / repeat / 末端)只进 accuracyScore。
 *
 * 我们把"滑条整体"挂在带 `counted` 的那个事件上(stable 是末端、lazer 是头),
 * 所以判据就是"有没有 counted" —— 而不是看 part 名字。同一个 part 名在两种
 * 口径下含义不同,按名字判会错。
 */
function affectsComboMultiplier(part: JudgementPart, counted: HitResult | undefined): boolean {
  if (part === 'circle' || part === 'spinner') return true;
  return counted !== undefined;
}
