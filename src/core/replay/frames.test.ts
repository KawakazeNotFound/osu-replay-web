import { describe, expect, it } from 'vitest';

import { ReplayKey, buildReplayFrames, cursorAt, normalizeKeys } from './frames';

describe('buildReplayFrames', () => {
  it('剔除 -12345 的 seed 哨兵帧', () => {
    const frames = buildReplayFrames([
      { startTime: 0, x: 0, y: 0, keys: 0 },
      { startTime: 100, x: 10, y: 20, keys: 0 },
      // stable 会在末尾塞一帧 time == -12345 承载 RNG seed,不是真实输入
      { startTime: -12345, x: 0, y: 0, keys: 0 },
    ]);

    expect(frames.count).toBe(2);
    expect(Array.from(frames.time)).toEqual([0, 100]);
  });

  it('按时间排序 —— 不假定解析器给的有序', () => {
    const frames = buildReplayFrames([
      { startTime: 300, x: 3, y: 3, keys: 0 },
      { startTime: 100, x: 1, y: 1, keys: 0 },
      { startTime: 200, x: 2, y: 2, keys: 0 },
    ]);

    expect(Array.from(frames.time)).toEqual([100, 200, 300]);
    expect(Array.from(frames.x)).toEqual([1, 2, 3]);
  });

  it('剔除非有限的时间戳', () => {
    const frames = buildReplayFrames([
      { startTime: 0, x: 0, y: 0, keys: 0 },
      { startTime: Number.NaN, x: 1, y: 1, keys: 0 },
    ]);

    expect(frames.count).toBe(1);
  });

  // 真实回放里存在 interval == 0 的零间隔帧(实测 4 个样本各有 16~69 对),
  // 且多数重复对的按键状态不同 —— 一次点击可以整个发生在零长度间隔内。
  // 见 TECH-NOTES B6。
  it('保留重复时间戳的帧 —— 去重会丢按键', () => {
    const frames = buildReplayFrames([
      { startTime: 100, x: 10, y: 10, keys: 0 },
      { startTime: 200, x: 20, y: 20, keys: 0 },
      { startTime: 200, x: 20, y: 20, keys: ReplayKey.K1 | ReplayKey.M1 },
      { startTime: 300, x: 30, y: 30, keys: 0 },
    ]);

    expect(frames.count).toBe(4);
    expect(Array.from(frames.time)).toEqual([100, 200, 200, 300]);
    // 两帧同时刻但按键不同,两者都必须在
    expect(frames.keys[1]).toBe(0);
    expect(frames.keys[2]).toBe(ReplayKey.K1 | ReplayKey.M1);
  });

  it('时间相同的帧保持原有先后顺序 —— 排序必须稳定', () => {
    // 若排序不稳定,"先松开后按下"可能被翻成"先按下后松开",按键序列就反了
    const frames = buildReplayFrames([
      { startTime: 500, x: 0, y: 0, keys: 0 },
      { startTime: 200, x: 1, y: 1, keys: ReplayKey.M1 },
      { startTime: 200, x: 2, y: 2, keys: 0 },
      { startTime: 200, x: 3, y: 3, keys: ReplayKey.M2 },
    ]);

    expect(Array.from(frames.time)).toEqual([200, 200, 200, 500]);
    expect(Array.from(frames.x)).toEqual([1, 2, 3, 0]);
    expect(Array.from(frames.keys)).toEqual([ReplayKey.M1, 0, ReplayKey.M2, 0]);
  });
});

describe('normalizeKeys', () => {
  it('消除 stable 的 K1→M1 / K2→M2 冗余置位', () => {
    // stable 按下 K1 时会同时置位 M1,直接数位数会把一次点击算成两次
    expect(normalizeKeys(ReplayKey.K1 | ReplayKey.M1)).toBe(ReplayKey.M1);
    expect(normalizeKeys(ReplayKey.K2 | ReplayKey.M2)).toBe(ReplayKey.M2);
    expect(normalizeKeys(ReplayKey.K1)).toBe(ReplayKey.M1);
    expect(normalizeKeys(ReplayKey.K2)).toBe(ReplayKey.M2);
  });

  it('两键同时按下时保留两位', () => {
    const both = normalizeKeys(ReplayKey.K1 | ReplayKey.K2);
    expect(both).toBe(ReplayKey.M1 | ReplayKey.M2);
  });

  it('丢弃 Smoke —— 它不参与判定', () => {
    expect(normalizeKeys(ReplayKey.Smoke)).toBe(0);
  });
});

describe('cursorAt', () => {
  const frames = buildReplayFrames([
    { startTime: 0, x: 0, y: 0, keys: 0 },
    { startTime: 100, x: 100, y: 200, keys: ReplayKey.K1 },
    { startTime: 200, x: 300, y: 400, keys: 0 },
  ]);

  it('位置在相邻帧之间线性插值', () => {
    const mid = cursorAt(frames, 50);
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeCloseTo(100);
  });

  it('按键不插值 —— 取 t 之前最后一帧的值', () => {
    // 若按键也插值会产生"幽灵点击":两帧之间凭空出现按下状态
    expect(cursorAt(frames, 50).keys).toBe(0);
    expect(cursorAt(frames, 150).keys).toBe(ReplayKey.K1);
  });

  it('落在帧上时取该帧的精确值', () => {
    const exact = cursorAt(frames, 100);
    expect(exact.x).toBeCloseTo(100);
    expect(exact.y).toBeCloseTo(200);
    expect(exact.frameIndex).toBe(1);
  });

  it('早于第一帧时钉在第一帧位置且无按键', () => {
    const before = cursorAt(frames, -500);
    expect(before.x).toBe(0);
    expect(before.keys).toBe(0);
    expect(before.frameIndex).toBe(-1);
  });

  it('晚于最后一帧时钉在最后一帧', () => {
    const after = cursorAt(frames, 9999);
    expect(after.x).toBeCloseTo(300);
    expect(after.y).toBeCloseTo(400);
    expect(after.frameIndex).toBe(2);
  });

  it('空回放返回判定区中心而不是崩掉', () => {
    const empty = buildReplayFrames([]);
    const sample = cursorAt(empty, 1234);
    expect(sample.x).toBe(256);
    expect(sample.y).toBe(192);
    expect(sample.frameIndex).toBe(-1);
  });

  it('查询顺序不影响结果 —— cursorAt 必须是纯函数', () => {
    const times = [0, 25, 50, 75, 100, 125, 150, 175, 200];
    const forward = times.map((t) => cursorAt(frames, t).x);
    const backward = [...times].reverse().map((t) => cursorAt(frames, t).x).reverse();

    expect(backward).toEqual(forward);
  });

  it('遇到重复时间戳取同时刻的最后一帧 —— 后一帧才是更新的状态', () => {
    const dup = buildReplayFrames([
      { startTime: 0, x: 0, y: 0, keys: 0 },
      { startTime: 100, x: 100, y: 100, keys: 0 },
      { startTime: 100, x: 100, y: 100, keys: ReplayKey.M1 },
      { startTime: 200, x: 200, y: 200, keys: 0 },
    ]);

    const sample = cursorAt(dup, 100);
    expect(sample.frameIndex).toBe(2);
    expect(sample.keys).toBe(ReplayKey.M1);
  });

  it('零间隔不会让插值除零', () => {
    const dup = buildReplayFrames([
      { startTime: 100, x: 10, y: 10, keys: 0 },
      { startTime: 100, x: 20, y: 20, keys: 0 },
      { startTime: 100, x: 30, y: 30, keys: 0 },
      { startTime: 300, x: 40, y: 40, keys: 0 },
    ]);

    for (const t of [99, 100, 100.5, 200, 300, 301]) {
      const s = cursorAt(dup, t);
      expect(Number.isFinite(s.x), `t=${t}`).toBe(true);
      expect(Number.isFinite(s.y), `t=${t}`).toBe(true);
    }
  });
});
