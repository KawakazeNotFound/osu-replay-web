import type { HitObjectKind } from './types';

/**
 * 物件堆叠(stacking)。
 *
 * osu 会把**位置相近、时间相邻**的物件依次错开一点,避免完全重叠。
 * 这不只是视觉效果 —— lazer 的命中检测用的是 `StackedPosition`,所以堆叠
 * 算错会直接让判定位置偏掉,拖累 A2(复现原始成绩)。
 *
 * ## 来源
 *
 * 逐行对照 `ppy/osu` master 的
 * `osu.Game.Rulesets.Osu/Beatmaps/OsuBeatmapProcessor.cs`(2026-08-23 核对),
 * 并与 `osu-standard-stable@5.0.1` 的实现交叉比对过。
 *
 * ## ⚠️ 不要"顺手简化"这里
 *
 * 这段代码有几处看起来多余、实际必需的细节。改之前先读注释:
 *
 * 1. **两处 `(int)` 截断**,且只有两处。lazer 注释写明 "truncation to integer
 *    is required to match stable"。少截断则边界情况下堆叠层数不同。
 * 2. **circle 分支比 start-vs-end 并截断;slider 分支比 start-vs-start 且不截断。**
 *    两个分支的时间比较规则**不一样**,不能统一。
 * 3. **距离用严格小于 `< 3`**。恰好相距 3 单位**不**堆叠。
 * 4. **`objectI` 会在内层循环里被重新指向**(`objectI = objectN`),
 *    于是 `objectI.stackHeight` 随之改变 —— 这是"链式堆叠"的实现方式,
 *    不是笔误。
 * 5. **偏移可以是负数**:圈叠在滑条尾上时往右下偏,lazer 注释说
 *    "bump notes down and right, rather than up and left"。
 */

/** 允许堆叠的最大距离(osu 坐标单位)。lazer 的 `STACK_DISTANCE`,是 int 3。 */
export const STACK_DISTANCE = 3;

/** 每层堆叠的偏移系数。lazer:`StackOffset = StackHeight * Scale * -6.4`。 */
export const STACK_OFFSET_FACTOR = -6.4;

/** 现代堆叠算法适用的最低 `.osu` 格式版本。更老的走 legacy 算法。 */
export const FIRST_MODERN_STACKING_FORMAT = 6;

/** 堆叠算法需要的物件信息。刻意只要这几项,与完整的 `SimHitObject` 解耦。 */
export interface StackableObject {
  readonly kind: HitObjectKind;
  readonly startTime: number;
  readonly endTime: number;
  /** 起点(未堆叠) */
  readonly x: number;
  readonly y: number;
  /** 末端(未堆叠)。circle / spinner 等于起点;slider 是路径末端且考虑 repeat。 */
  readonly endX: number;
  readonly endY: number;
}

export interface StackingOptions {
  /** `.osu` 的 StackLeniency */
  readonly stackLeniency: number;
  /**
   * preempt(ms),**必须已经取整**。
   *
   * lazer 的阈值是 `(int)hitObject.TimePreempt * StackLeniency` —— 只截断
   * preempt,不截断乘积。而顶层物件的 `TimePreempt` 本来就是
   * `DifficultyRangeInt` 的产物(已是整数),所以传 `preemptFromAR(ar)` 即可。
   */
  readonly timePreempt: number;
  /** `.osu` 的 fileFormat,用于选择算法分支 */
  readonly fileFormat: number;
}

/**
 * 算出每个物件的堆叠层数。返回与输入同序的数组,可含负值。
 *
 * @throws 若 `fileFormat < 6`(legacy 算法未实现,见下)
 */
export function computeStackHeights(
  objects: readonly StackableObject[],
  options: StackingOptions,
): Int32Array {
  const heights = new Int32Array(objects.length);
  if (objects.length === 0) return heights;

  if (options.fileFormat < FIRST_MODERN_STACKING_FORMAT) {
    // legacy 算法(`applyStackingOld`)刻意未实现:手上没有 v6 以下的谱面可测,
    // 而照着文字描述写一个测不了的算法,出错概率高于不做 —— 错的堆叠比没堆叠更糟。
    // v6 是 2008 年的格式,流通中的图基本都远高于此。
    throw new Error(
      `.osu fileFormat ${options.fileFormat} < ${FIRST_MODERN_STACKING_FORMAT},` +
        '需要 legacy 堆叠算法(applyStackingOld),本项目尚未实现。' +
        '这是 2008 年前的格式,若真遇到请提 issue 并附上谱面。',
    );
  }

  applyStackingModern(objects, heights, options);
  return heights;
}

/**
 * `OsuBeatmapProcessor.applyStacking` 的现代分支。
 *
 * 注:lazer 在这之前还有一个"前向扩展 pass",它的守卫是
 * `if (endIndex < hitObjects.Count - 1)`。而全图调用时
 * `endIndex == Count - 1`,该条件恒假 —— 那段代码只在编辑器按子区间增量更新时
 * 才会跑。本项目只做全图,故不实现;`osu-standard-stable` 照抄了那段,
 * 但同样永远进不去。
 */
function applyStackingModern(
  objects: readonly StackableObject[],
  heights: Int32Array,
  options: StackingOptions,
): void {
  const { stackLeniency, timePreempt } = options;

  // lazer:`(int)TimePreempt * StackLeniency`。只截断 preempt,乘积保留小数。
  // timePreempt 由调用方保证已取整(见 StackingOptions 注释)。
  const stackThreshold = Math.trunc(timePreempt) * stackLeniency;

  const startIndex = 0;
  const endIndex = objects.length - 1;
  let extendedStartIndex = startIndex;

  // 倒序:从后往前处理,让"交错的堆叠"能正确串起来。
  // lazer 注释举的例子:从 4 处理到 2,再走到 3 处理 1。
  for (let i = endIndex; i > startIndex; i--) {
    let n = i;
    // ⚠️ objectIndex 会在内层循环里被重新指向(链式堆叠),不是笔误
    let objectIndex = i;

    if (heights[objectIndex] !== 0 || objects[objectIndex]!.kind === 'spinner') continue;

    if (objects[objectIndex]!.kind === 'circle') {
      while (--n >= 0) {
        const objectN = objects[n]!;
        if (objectN.kind === 'spinner') continue;

        // ⚠️ 截断点之一:两个操作数**各自**转 int 后再相减,比较用严格大于。
        // lazer 注释:两个被减量在 stable 里都是整数,所以必须先截断。
        if (Math.trunc(objects[objectIndex]!.startTime) - Math.trunc(objectN.endTime) > stackThreshold) {
          break;
        }

        // 越过已处理范围的物件要先归零 —— 它们还没被本轮重置过
        if (n < extendedStartIndex) {
          heights[n] = 0;
          extendedStartIndex = n;
        }

        // 圈落在**滑条尾**上:负向堆叠(往右下),并把中间同处的物件一起下推
        if (
          objectN.kind === 'slider' &&
          distance(objectN.endX, objectN.endY, objects[objectIndex]!.x, objects[objectIndex]!.y) <
            STACK_DISTANCE
        ) {
          const offset = heights[objectIndex]! - heights[n]! + 1;

          for (let j = n + 1; j <= i; j++) {
            const objectJ = objects[j]!;
            if (
              distance(objectN.endX, objectN.endY, objectJ.x, objectJ.y) < STACK_DISTANCE
            ) {
              heights[j]! -= offset;
            }
          }

          // 跳出后该滑条会作为新的堆叠基点被重新处理
          break;
        }

        // 普通情况:位置相近则前一个物件叠高一层,并把它设为新的参照
        if (
          distance(objectN.x, objectN.y, objects[objectIndex]!.x, objects[objectIndex]!.y) <
          STACK_DISTANCE
        ) {
          heights[n] = heights[objectIndex]! + 1;
          objectIndex = n;
        }
      }
      continue;
    }

    if (objects[objectIndex]!.kind === 'slider') {
      // lazer 注释:从第一个滑条起,堆叠"ALWAYS stack positive regardless"
      while (--n >= startIndex) {
        const objectN = objects[n]!;
        if (objectN.kind === 'spinner') continue;

        // ⚠️ 与 circle 分支**不同**:这里比的是 start-vs-start,且**不截断**
        if (objects[objectIndex]!.startTime - objectN.startTime > stackThreshold) break;

        if (
          distance(objectN.endX, objectN.endY, objects[objectIndex]!.x, objects[objectIndex]!.y) <
          STACK_DISTANCE
        ) {
          heights[n] = heights[objectIndex]! + 1;
          objectIndex = n;
        }
      }
    }
  }
}

/**
 * 欧氏距离。
 *
 * ⚠️ 已知微小分歧:osu 里坐标与距离都是 **float32**,这里用 float64 算。
 * 只有当距离落在 `3` 附近约 1e-7 以内时结论才可能不同 —— 概率极低,
 * 但若将来 A2 出现"个别物件堆叠层数差 1",这里是嫌疑点之一。
 * (`osu-standard-stable` 用的是 float32 的 `fdistance`。)
 */
function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 堆叠层数 → 坐标偏移。
 *
 * lazer:`StackOffset = StackHeight * Scale * -6.4`,其中 `Scale = Radius / 64`。
 * 两个轴用同一个偏移量(往左上,负 stackHeight 则往右下)。
 *
 * 0 层显式返回 `0` 而非 `-0`:`0 * scale * -6.4` 在 JS 里得 `-0`,虽然
 * `x + -0 === x` 不影响坐标,但 `-0` 留在数据结构里会让 `Object.is` 与
 * 快照比较出现莫名不等。
 */
export function stackOffset(stackHeight: number, scale: number): number {
  if (stackHeight === 0) return 0;
  return stackHeight * scale * STACK_OFFSET_FACTOR;
}
