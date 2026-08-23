/**
 * 单调递增数组上的二分查找。
 *
 * 整个项目的 seek 都建立在这个函数上 —— 判定事件、回放帧、drain 区间
 * 都是按时间升序存储的,查询"t 时刻的状态"一律归约成"找最后一个 <= t 的下标"。
 */

type NumericArray = Float64Array | Float32Array | Int32Array | readonly number[];

/**
 * 在升序数组的 [0, length) 区间内,找最后一个满足 `arr[i] <= target` 的下标。
 *
 * @returns 下标;若 target 小于所有元素则返回 -1。
 */
export function lastIndexAtOrBefore(arr: NumericArray, length: number, target: number): number {
  let lo = 0;
  let hi = length - 1;
  let found = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return found;
}

/**
 * 在升序数组的 [0, length) 区间内,找第一个满足 `arr[i] >= target` 的下标。
 *
 * @returns 下标;若 target 大于所有元素则返回 length。
 */
export function firstIndexAtOrAfter(arr: NumericArray, length: number, target: number): number {
  let lo = 0;
  let hi = length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
