import { describe, expect, it } from 'vitest';

import { clamp, firstIndexAtOrAfter, lastIndexAtOrBefore } from './search';

/**
 * 二分查找是整个 seek 的地基,而二分最容易在**边界**与**重复值**上错。
 * 重复值不是假想情况:真实回放存在零间隔帧,`frames.time` 是非严格升序
 * (见 TECH-NOTES B6),下游全靠这两个函数在重复段上的行为是确定的。
 *
 * 所有用例都对照暴力线性扫描,而不是对照"我以为的答案"。
 */

function bruteLastAtOrBefore(arr: readonly number[], length: number, target: number): number {
  let found = -1;
  for (let i = 0; i < length; i++) if (arr[i]! <= target) found = i;
  return found;
}

function bruteFirstAtOrAfter(arr: readonly number[], length: number, target: number): number {
  for (let i = 0; i < length; i++) if (arr[i]! >= target) return i;
  return length;
}

/** 覆盖:空、单元素、全重复、部分重复、含负数、长序列 */
const CASES: readonly (readonly number[])[] = [
  [],
  [0],
  [5],
  [1, 2],
  [2, 2],
  [1, 1, 1, 1],
  [0, 10, 20, 30, 40],
  [-1000, -500, -500, 0, 0, 0, 1, 999],
  [-1781, -1764, -1747, 0, 17, 34, 34, 35, 36, 100],
  Array.from({ length: 257 }, (_, i) => i * 3),
  Array.from({ length: 100 }, (_, i) => Math.floor(i / 4)), // 大量重复
];

/** 针对某个数组生成足够刁钻的查询点:每个元素及其 ±1、两端之外、中间值 */
function probesFor(arr: readonly number[]): number[] {
  const probes = [-1e9, 1e9, 0, -0.5, 0.5];
  for (const v of arr) probes.push(v - 1, v - 0.5, v, v + 0.5, v + 1);
  return probes;
}

describe('lastIndexAtOrBefore', () => {
  it('与暴力扫描逐点一致', () => {
    for (const arr of CASES) {
      const typed = Float64Array.from(arr);
      for (const t of probesFor(arr)) {
        expect(
          lastIndexAtOrBefore(typed, arr.length, t),
          `arr=[${arr}] t=${t}`,
        ).toBe(bruteLastAtOrBefore(arr, arr.length, t));
      }
    }
  });

  it('重复值时取**最后**一个 —— cursorAt 依赖这一点', () => {
    const arr = Float64Array.from([0, 100, 100, 100, 200]);
    expect(lastIndexAtOrBefore(arr, 5, 100)).toBe(3);
    expect(lastIndexAtOrBefore(arr, 5, 150)).toBe(3);
    expect(lastIndexAtOrBefore(arr, 5, 99)).toBe(0);
  });

  it('target 小于全部元素时返回 -1', () => {
    const arr = Float64Array.from([10, 20, 30]);
    expect(lastIndexAtOrBefore(arr, 3, 9)).toBe(-1);
    expect(lastIndexAtOrBefore(arr, 3, -1e9)).toBe(-1);
  });

  it('target 大于全部元素时返回末位', () => {
    const arr = Float64Array.from([10, 20, 30]);
    expect(lastIndexAtOrBefore(arr, 3, 31)).toBe(2);
    expect(lastIndexAtOrBefore(arr, 3, 1e9)).toBe(2);
  });

  it('空区间返回 -1', () => {
    expect(lastIndexAtOrBefore(new Float64Array(0), 0, 0)).toBe(-1);
    // length 参数小于数组实际长度时,只看前 length 个
    expect(lastIndexAtOrBefore(Float64Array.from([1, 2, 3]), 0, 999)).toBe(-1);
  });

  it('尊重 length 参数,不越界读取', () => {
    const arr = Float64Array.from([10, 20, 30, 40, 50]);
    expect(lastIndexAtOrBefore(arr, 3, 1e9)).toBe(2); // 只看前 3 个
    expect(lastIndexAtOrBefore(arr, 3, 45)).toBe(2);
  });
});

describe('firstIndexAtOrAfter', () => {
  it('与暴力扫描逐点一致', () => {
    for (const arr of CASES) {
      const typed = Float64Array.from(arr);
      for (const t of probesFor(arr)) {
        expect(
          firstIndexAtOrAfter(typed, arr.length, t),
          `arr=[${arr}] t=${t}`,
        ).toBe(bruteFirstAtOrAfter(arr, arr.length, t));
      }
    }
  });

  it('重复值时取**第一**个', () => {
    const arr = Float64Array.from([0, 100, 100, 100, 200]);
    expect(firstIndexAtOrAfter(arr, 5, 100)).toBe(1);
    expect(firstIndexAtOrAfter(arr, 5, 99)).toBe(1);
    expect(firstIndexAtOrAfter(arr, 5, 101)).toBe(4);
  });

  it('target 大于全部元素时返回 length(而非 -1)', () => {
    const arr = Float64Array.from([10, 20, 30]);
    expect(firstIndexAtOrAfter(arr, 3, 31)).toBe(3);
    expect(firstIndexAtOrAfter(arr, 3, 1e9)).toBe(3);
  });

  it('空区间返回 0', () => {
    expect(firstIndexAtOrAfter(new Float64Array(0), 0, 0)).toBe(0);
  });
});

describe('两个函数的互补关系', () => {
  it('target 恰好命中时,两者夹出该值的重复段', () => {
    const arr = Float64Array.from([0, 100, 100, 100, 200]);
    const first = firstIndexAtOrAfter(arr, 5, 100);
    const last = lastIndexAtOrBefore(arr, 5, 100);
    expect(first).toBe(1);
    expect(last).toBe(3);
    for (let i = first; i <= last; i++) expect(arr[i]).toBe(100);
  });

  it('target 落在空隙里时 last + 1 == first', () => {
    const arr = Float64Array.from([0, 100, 200]);
    for (const t of [50, 150]) {
      expect(lastIndexAtOrBefore(arr, 3, t) + 1, `t=${t}`).toBe(firstIndexAtOrAfter(arr, 3, t));
    }
  });
});

describe('支持多种数组类型', () => {
  it('Float32Array / Int32Array / 普通数组都能用', () => {
    const values = [10, 20, 30];
    expect(lastIndexAtOrBefore(Float32Array.from(values), 3, 25)).toBe(1);
    expect(lastIndexAtOrBefore(Int32Array.from(values), 3, 25)).toBe(1);
    expect(lastIndexAtOrBefore(values, 3, 25)).toBe(1);
    expect(firstIndexAtOrAfter(values, 3, 25)).toBe(2);
  });
});

describe('clamp', () => {
  it('落在区间内时原样返回', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('超出时夹到边界', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('支持负区间(lead-in 的时间轴起点是负数)', () => {
    expect(clamp(-2000, -1476, 231476)).toBe(-1476);
    expect(clamp(-1000, -1476, 231476)).toBe(-1000);
  });

  it('min == max 时恒返回该值', () => {
    expect(clamp(5, 3, 3)).toBe(3);
    expect(clamp(1, 3, 3)).toBe(3);
  });
});
