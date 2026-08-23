import type { HitObjectKind, SimBeatmap, SimHitObject } from './types';

/**
 * 滑条的嵌套部件(刻度 / repeat / 尾)与理论最大 combo。
 *
 * ## 来源
 *
 * 对照 `ppy/osu` master(2026-08-23 核对):
 * - `osu.Game.Rulesets.Osu/Objects/Slider.cs` → `ApplyDefaultsToSelf`
 * - `osu.Game/Rulesets/Objects/Legacy/LegacyRulesetExtensions.cs`
 *   → `GetPrecisionAdjustedBeatLength`
 * - `osu.Game/Rulesets/Objects/SliderEventGenerator.cs`(经 osu-classes 的
 *   `EventGenerator` 交叉比对)
 *
 * ## ⚠️ 一个把我带偏过的错误前提
 *
 * 最初想用"FC 回放的 maxCombo"反推刻度数,推出 `stable.osu` 应有 18 个刻度,
 * 而公式给 19,以为是浮点边界问题。**错在前提上:**
 *
 * **`countMiss == 0` 不等于 full combo。** stable 里漏掉滑条尾或某个刻度会产生
 * **slider break** —— 它打断 combo 但**不计入 miss**。所以 0 miss 的成绩
 * 完全可以没拿到理论最大 combo。
 *
 * 实测:`stable.osu` 理论最大 1152,该回放拿到 1151(最后一条滑条断了一次);
 * `lazer.osu` 理论 346 == 实际 346,那张才是真正的 full combo —— 也正是它
 * 精确确认了本文件的公式。
 *
 * 所以 `.osr` 的 maxCombo 只能当**上界**用,不能当等式,除非已知是真 FC。
 */

/** lazer 的 `OsuHitObject.BASE_SCORING_DISTANCE`。 */
export const BASE_SCORING_DISTANCE = 100;

/**
 * 刻度与滑条末端之间必须留出的最小距离。
 *
 * lazer `SliderEventGenerator`:`minDistanceFromEnd = velocity * 10`。
 * 太靠近末端的刻度会被丢掉(否则它与滑条尾几乎同时,不合理)。
 */
function minDistanceFromEnd(velocity: number): number {
  return velocity * 10;
}

/** lazer `SliderEventGenerator` 里的 `max_length`,给用户手改过的边缘谱面兜底。 */
const SLIDER_MAX_DISTANCE = 100000;

export interface SliderTickInput {
  /** 路径长度(osu 单位) */
  readonly pathDistance: number;
  /** 每 ms 前进的距离。osu-parsers 已在解码时算好 */
  readonly velocity: number;
  /** span 数 = repeat + 1 */
  readonly spans: number;
  /** 该滑条起点处生效的(非继承)timing point 的 beatLength */
  readonly beatLength: number;
  /** 谱面的 SliderTickRate */
  readonly sliderTickRate: number;
}

/**
 * 刻度间距。
 *
 * lazer:`scoringDistance = Velocity * timingPoint.BeatLength`,然后
 * `TickDistance = scoringDistance / SliderTickRate * TickDistanceMultiplier`。
 *
 * ⚠️ lazer 的注释明确说**不要**把 `scoringDistance` 写成
 * `BASE_SCORING_DISTANCE * sliderMultiplier` —— 它刻意保留 stable 的浮点误差
 * ("intentionally introducing floating point errors to match stable")。
 * 所以这里也走 `velocity * beatLength` 这条路,而不是"化简"成常量乘法。
 *
 * `TickDistanceMultiplier` 对 v8 及以上的谱面是 1,故略去。
 */
export function tickDistanceOf(input: SliderTickInput): number {
  const scoringDistance = input.velocity * input.beatLength;
  return scoringDistance / input.sliderTickRate;
}

/**
 * 一条滑条的刻度总数。
 *
 * lazer 的生成逻辑是每个 span 各自铺刻度,从 `tickDistance` 起按步长累加,
 * 条件是 `distance < sliderDistance - minDistanceFromEnd`(**严格小于**)。
 * 每个 span 的刻度数相同,所以总数 = 单 span 数 × span 数。
 */
export function tickCountOf(input: SliderTickInput): number {
  const sliderDistance = Math.min(SLIDER_MAX_DISTANCE, input.pathDistance);
  const tickDistance = tickDistanceOf(input);

  // lazer:tickDistance 为 0 或无穷时完全不生成刻度
  if (!Number.isFinite(tickDistance) || tickDistance <= 0) return 0;

  const limit = sliderDistance - minDistanceFromEnd(input.velocity);

  let perSpan = 0;
  for (let d = tickDistance; d < limit; d += tickDistance) perSpan++;

  return perSpan * Math.max(1, input.spans);
}

/**
 * 滑条末端判定的历史偏移(ms,**负数**)。
 *
 * lazer 的 `SliderEventGenerator.TAIL_LENIENCY = -36`。滑条的最终判定点历史上
 * 被前移了 36ms,现在只为 osu!catch 转换与难度兼容保留 —— 但 stable 回放的
 * 判定确实按这个走。
 */
export const TAIL_LENIENCY = -36;

/** 滑条的嵌套部件种类。 */
export type SliderPartKind = 'tick' | 'repeat' | 'legacyLastTick';

/**
 * 滑条的一个嵌套部件。
 *
 * ⚠️ 只生成**参与判定**的三种。lazer 的 `SliderEventGenerator` 还会产出 `Head`
 * 与 `Tail`,但:
 * - `Head` 我们已经当作滑条本体判了(见 `judgement.ts`)
 * - `Tail` 在 lazer 的 `Slider.CreateNestedHitObjects` 里**没有**被用来建嵌套物件;
 *   真正的 `SliderTailCircle` 是从 **`LegacyLastTick`** 建的(时刻 = 末尾 - 36ms)
 */
export interface SliderPart {
  readonly kind: SliderPartKind;
  /** 判定时刻(ms) */
  readonly time: number;
  /** 路径进度 0..1,用于算该部件的位置 */
  readonly pathProgress: number;
  readonly spanIndex: number;
}

export interface SliderPartsInput extends SliderTickInput {
  readonly startTime: number;
  /** 整条滑条的时长(ms) */
  readonly duration: number;
}

/**
 * 生成滑条的嵌套部件,按时间升序。
 *
 * 逐行对照 lazer 的 `SliderEventGenerator.Generate`。几处不能改的细节:
 *
 * 1. **刻度进度从路径起点算**(`d / length`),不是从 span 起点 ——
 *    这样 repeat span 的刻度会落在完全相同的位置上
 * 2. **反向 span 的时间进度取反**(`1 - pathProgress`),然后整段 `reverse()`
 *    让时间恢复升序
 * 3. `legacyLastTick` 的时刻是 `max(起点 + 总时长/2, 末尾 - 36)` ——
 *    **取较晚者**,所以短于 72ms 的滑条宽容会小于 36ms
 * 4. lazer 注释说末尾那个表达式**故意不化简**,为了匹配 stable 的浮点精度
 */
export function generateSliderParts(input: SliderPartsInput): SliderPart[] {
  const spans = Math.max(1, input.spans);
  const spanDuration = input.duration / spans;

  const length = Math.min(SLIDER_MAX_DISTANCE, input.pathDistance);
  const tickDistance = clamp(tickDistanceOf(input), 0, length);
  const minFromEnd = minDistanceFromEnd(input.velocity);

  const parts: SliderPart[] = [];

  for (let span = 0; span < spans; span++) {
    const spanStartTime = input.startTime + span * spanDuration;
    const reversed = span % 2 === 1;

    if (tickDistance > 0 && Number.isFinite(tickDistance)) {
      const ticks: SliderPart[] = [];

      for (let d = tickDistance; d <= length; d += tickDistance) {
        // lazer:先判 <= length,再在循环体里 break —— 与 d < length - minFromEnd 等价
        if (d >= length - minFromEnd) break;

        const pathProgress = d / length;
        const timeProgress = reversed ? 1 - pathProgress : pathProgress;

        ticks.push({
          kind: 'tick',
          time: spanStartTime + timeProgress * spanDuration,
          pathProgress,
          spanIndex: span,
        });
      }

      // 反向 span 的刻度是按时间倒序生成的,翻回来
      if (reversed) ticks.reverse();
      parts.push(...ticks);
    }

    if (span < spans - 1) {
      parts.push({
        kind: 'repeat',
        time: spanStartTime + spanDuration,
        pathProgress: (span + 1) % 2,
        spanIndex: span,
      });
    }
  }

  // legacyLastTick —— 它才是 stable 的"滑条末端"判定点
  const totalDuration = spans * spanDuration;
  const finalSpanIndex = spans - 1;
  const finalSpanStartTime = input.startTime + finalSpanIndex * spanDuration;

  const legacyTime = Math.max(
    input.startTime + totalDuration / 2,
    // 刻意不化简成 startTime + totalDuration + TAIL_LENIENCY,见函数注释第 4 条
    finalSpanStartTime + spanDuration + TAIL_LENIENCY,
  );

  let legacyProgress = (legacyTime - finalSpanStartTime) / spanDuration;
  if (spans % 2 === 0) legacyProgress = 1 - legacyProgress;

  parts.push({
    kind: 'legacyLastTick',
    time: legacyTime,
    pathProgress: clamp(legacyProgress, 0, 1),
    spanIndex: finalSpanIndex,
  });

  return parts;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * 一个物件对 combo 的贡献(全部命中时)。
 *
 * - circle / spinner:1
 * - slider:1(头)+ 刻度数 + repeat 数 + 1(末端)
 */
export function comboContributionOf(object: SimHitObject): number {
  if (object.kind !== 'slider') return 1;

  const repeats = Math.max(0, object.spans - 1);
  return 1 + object.tickCount + repeats + 1;
}

/**
 * 谱面的**理论最大 combo**(全部部件都命中)。
 *
 * 用途:A2 的上界断言。`.osr` 的 maxCombo 必须 `<=` 这个值;若已知回放是
 * 真 full combo(比如实测 `lazer.osu` 那张),则应**精确相等**。
 *
 * ⚠️ 不要反过来用它推刻度数 —— 见本文件顶部关于 slider break 的说明。
 */
export function theoreticalMaxCombo(beatmap: SimBeatmap): number {
  let total = 0;
  for (const o of beatmap.hitObjects) total += comboContributionOf(o);
  return total;
}

/** 便于调试:按物件类型统计 combo 贡献的构成。 */
export function comboBreakdown(beatmap: SimBeatmap): {
  readonly objects: number;
  readonly ticks: number;
  readonly repeats: number;
  readonly tails: number;
  readonly total: number;
} {
  let ticks = 0;
  let repeats = 0;
  let tails = 0;

  for (const o of beatmap.hitObjects) {
    if (o.kind !== 'slider') continue;
    ticks += o.tickCount;
    repeats += Math.max(0, o.spans - 1);
    tails += 1;
  }

  const objects = beatmap.hitObjects.length;
  return { objects, ticks, repeats, tails, total: objects + ticks + repeats + tails };
}

/** 供 loader 使用:判断某个种类是否需要算刻度。 */
export function needsTicks(kind: HitObjectKind): boolean {
  return kind === 'slider';
}
