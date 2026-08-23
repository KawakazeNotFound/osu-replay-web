import type { LegacyReplayFrame, Score, ScoreInfo } from 'osu-classes';

import { buildReplayFrames, type RawReplayFrame, type ReplayFrames } from '../replay/frames';

/**
 * .osr 头部记录的原始成绩。
 *
 * 这是校验判定实现的**黄金标准**:我们自己模拟出来的分数/连击/准确率必须
 * 与这里的值一致,否则整条时间线都是错的。见 TECH-NOTES A2。
 *
 * ⚠️ 刻意**不**收录 `rank` 与 `passed`:.osr 里根本没存这两项,
 * osu-parsers 是从准确率反推的,实测在 0 miss / 98.6% 的成绩上也返回
 * `rank="F"` / `passed=false`。显示它们等于显示假数据。
 */
export interface ReplayInfoSummary {
  /** 本地 stable 回放常常是空串(不记录本机玩家名),此时回落为 `(unknown)` */
  readonly playerName: string;
  readonly totalScore: number;
  readonly maxCombo: number;
  readonly accuracy: number;
  readonly count300: number;
  readonly count100: number;
  readonly count50: number;
  readonly countMiss: number;
  /** 可读 mod 缩写,如 `HDDT`;无 mod 为 `NM` */
  readonly mods: string;
  /** legacy mod 位掩码原值 */
  readonly rawMods: number;
  readonly beatmapHashMD5: string;
  readonly frameCount: number;
  /** 如 stable 的 `20260412`、lazer 的 `30000016` */
  readonly gameVersion: number;
  /** lazer 与 stable 的记分体系不同(见 M5),需要据此分流 */
  readonly isLazer: boolean;
}

export interface LoadedReplay {
  readonly frames: ReplayFrames;
  readonly info: ReplayInfoSummary;
  /**
   * 解析器返回的原始 `Score`。
   *
   * 保留是为了两件 summary 没收录但后续要用的东西:
   * `info.statistics`(判定计数的权威来源,A2 的比对基准)与
   * `replay.lifeBar`(stable 回放自带的 HP 曲线,D1 的比对基准;lazer 不带)。
   */
  readonly raw: Score;
}

/**
 * 解析 .osr。
 *
 * ✅ TECH-NOTES A1 已验证(2026-08-23):osu-parsers 4.1.7 自带 browser 构建
 * (`lib/browser.mjs`,只依赖 osu-classes + 纯 JS 的 lzma-js-simple-v2),
 * 在真实 Chrome 里解 stable(gameVersion 20260412)与 lazer(30000016)
 * 两种 .osr 均通过。字段映射按实测结果写死,不再做形状探测。
 *
 * 用动态 `import()` 是为了**代码分割**:解析器 + LZMA 独立成 chunk(71 kB / gzip 22 kB),
 * 首屏不必加载。用命名解构而非把整个命名空间存下来,是为了让 Rollup 能 tree-shake
 * 掉 BeatmapDecoder / StoryboardDecoder / 两个 Encoder —— 实测省掉一半体积。
 */
export async function loadReplay(data: ArrayBuffer): Promise<LoadedReplay> {
  const { ScoreDecoder } = await import('osu-parsers');

  const score = await new ScoreDecoder().decodeFromBuffer(new Uint8Array(data), true);

  const { replay } = score;
  if (replay === null) {
    throw new Error(
      '该 .osr 不含回放数据。常见于只有成绩头部的占位文件(如从 API 取到的在线成绩记录)。',
    );
  }

  const frames = buildReplayFrames(replay.frames.map(toRawFrame));

  return {
    frames,
    info: summarize(score.info, replay.gameVersion, frames.count),
    raw: score,
  };
}

/**
 * 单帧字段映射。
 *
 * `.osr` 解码出的一定是 `LegacyReplayFrame`(`startTime` / `position: Vector2` /
 * `buttonState`),但 `Replay.frames` 的静态类型是更宽的 `ReplayFrame[]`
 * —— 后者不带位置与按键。所以这里断言 + 首帧运行时校验:
 * 若哪天解析器换了帧类型,要在第一帧就炸,而不是静默产出全 0 的光标轨迹。
 */
function toRawFrame(frame: unknown, index: number): RawReplayFrame {
  const f = frame as LegacyReplayFrame;

  if (
    index === 0 &&
    (typeof f.startTime !== 'number' || typeof f.buttonState !== 'number' || !f.position)
  ) {
    throw new Error(
      `回放帧不是预期的 LegacyReplayFrame。观察到的字段:[${Object.keys(f ?? {}).join(', ')}]。` +
        '请更新 toRawFrame() 的映射。',
    );
  }

  return {
    startTime: f.startTime,
    // 实测光标会跑出 playfield(512×384):stable 也能到 x∈[-20, 527]、y∈[-27, 397]。
    // 这里不做任何 clamp —— 越界是真实输入,渲染层自行决定怎么画。
    x: f.position.x,
    y: f.position.y,
    keys: f.buttonState,
  };
}

/** lazer 的 gameVersion 从 3000_0000 起跳,stable 是 `yyyymmdd` 形式。 */
const FIRST_LAZER_GAME_VERSION = 30000000;

function summarize(info: ScoreInfo, gameVersion: number, frameCount: number): ReplayInfoSummary {
  // ⚠️ 不用 info.mods:它是 ModCombination,需要先给 ScoreInfo 设 ruleset 才能
  // 物化,实测恒为 null。rawMods 位掩码才是 .osr 里真正存着的东西。
  const rawMods = toLegacyModBitmask(info.rawMods);

  return {
    playerName: info.username.length > 0 ? info.username : '(unknown)',
    totalScore: info.totalScore,
    maxCombo: info.maxCombo,
    accuracy: info.accuracy,
    count300: info.count300,
    count100: info.count100,
    count50: info.count50,
    countMiss: info.countMiss,
    mods: formatLegacyMods(rawMods),
    rawMods,
    beatmapHashMD5: info.beatmapHashMD5,
    frameCount,
    gameVersion,
    isLazer: gameVersion >= FIRST_LAZER_GAME_VERSION,
  };
}

/* ---------- legacy mod 位掩码 ---------- */

/** 按位序排列。下标 i 对应 `1 << i`。 */
export const LEGACY_MOD_ACRONYMS = [
  'NF', 'EZ', 'TD', 'HD', 'HR', 'SD', 'DT', 'RX',
  'HT', 'NC', 'FL', 'AT', 'SO', 'AP', 'PF', 'K4',
  'K5', 'K6', 'K7', 'K8', 'FI', 'RD', 'CN', 'TP',
  'K9', 'KC', 'K1', 'K3', 'K2', 'V2', 'MR',
] as const;

const BIT = Object.fromEntries(
  LEGACY_MOD_ACRONYMS.map((acronym, i) => [acronym, 1 << i]),
) as Record<(typeof LEGACY_MOD_ACRONYMS)[number], number>;

/**
 * 把 legacy mod 位掩码格式化成 `HDDT` 这样的缩写串。
 *
 * 处理三组"蕴含关系"—— stable 开这些 mod 时会同时置位被蕴含的那个,
 * 直接拼接会得到 `DTNC` / `SDPF` 这类冗余串:
 * NC⇒DT、PF⇒SD、CN⇒AT。
 *
 * ⚠️ 对 lazer 回放这是**有损投影**:lazer 独有的 mod 与 mod 参数
 * (例如倍速不是 1.5× 的 DT)在位掩码里表达不出来。M5 需要另读 lazer 的 mod 数据。
 */
export function formatLegacyMods(rawMods: number): string {
  if (rawMods === 0) return 'NM';

  const implied = 0 |
    (rawMods & BIT.NC ? BIT.DT : 0) |
    (rawMods & BIT.PF ? BIT.SD : 0) |
    (rawMods & BIT.CN ? BIT.AT : 0);

  const shown = rawMods & ~implied;
  const acronyms = LEGACY_MOD_ACRONYMS.filter((_, i) => shown & (1 << i));

  // 位掩码里出现了当前 osu 未定义的高位 —— 原样报出来,别悄悄吞掉
  return acronyms.length > 0 ? acronyms.join('') : `?0x${rawMods.toString(16)}`;
}

/**
 * 把 osu-classes 的 `rawMods` 归一化成位掩码。
 *
 * 该字段声明为 `string | number`:从 `.osr` 解码走数字分支(位掩码,实测 10/10 如此),
 * 但从 JSON 构造 `ScoreInfo` 时会变成 `"HDDT"` 这样的 2 字符缩写拼接串。
 * 这里两种都收,免得将来接在线成绩 API 时静默退化成无 mod。
 */
function toLegacyModBitmask(rawMods: string | number): number {
  if (typeof rawMods === 'number') return rawMods;

  const acronyms = rawMods.toUpperCase().match(/.{1,2}/g) ?? [];
  let bits = 0;
  for (const acronym of acronyms) {
    const bit = BIT[acronym as (typeof LEGACY_MOD_ACRONYMS)[number]];
    if (bit !== undefined) bits |= bit;
  }
  return bits;
}

/**
 * mod 带来的速度倍率。
 *
 * 回放帧的时间戳是**谱面时间**,DT 的含义是谱面时间相对真实时间跑得更快。
 * 所以要忠实还原一段 DT 回放,时钟推进谱面时间的速率必须是 1.5×,
 * 用户设定的倍速再乘在这之上。
 *
 * ⚠️ 只对 stable 回放准确。lazer 的 DT/HT 倍速可由玩家自定义(0.5×~2×),
 * 位掩码里读不到,一律返回 1.5 / 0.75 会出错。见 M5。
 */
export function speedMultiplierOfLegacyMods(rawMods: number): number {
  if (rawMods & (BIT.DT | BIT.NC)) return 1.5;
  if (rawMods & BIT.HT) return 0.75;
  return 1;
}
