import type { Beatmap, ControlPointInfo, HitObject, Vector2 } from 'osu-classes';

import { OBJECT_RADIUS, preemptFromAR, radiusFromCS } from '../sim/difficulty';
import { tickCountOf } from '../sim/sliderParts';
import { computeStackHeights, stackOffset, type StackableObject } from '../sim/stacking';
import type {
  BreakPeriod,
  Difficulty,
  HitObjectKind,
  SimBeatmap,
  SimHitObject,
} from '../sim/types';

/** `.osu` 里能读到的展示用元信息。模拟层不需要,UI 需要。 */
export interface BeatmapMetadata {
  readonly title: string;
  readonly artist: string;
  readonly creator: string;
  /** 难度名,如 `[Insane]` 里的 Insane */
  readonly version: string;
  readonly beatmapId: number;
  readonly beatmapSetId: number;
  readonly audioFilename: string;
  /** `.osu` 的格式版本。实测当前谱面为 14 */
  readonly fileFormat: number;
}

export interface LoadedBeatmap {
  readonly beatmap: SimBeatmap;
  readonly metadata: BeatmapMetadata;
  /** 解析器原始对象。滑条路径(M2)与 combo 颜色都还要从这里取。 */
  readonly raw: Beatmap;
}

/** osu! 的游戏模式。我们只做 std。 */
const MODE_OSU_STD = 0;

/**
 * `hitType` 是位域,不是枚举值 —— 一个 slider 的 hitType 可能是 `2|4 = 6`。
 * 取自 osu-classes 的 `HitType`,这里写成常量以免依赖枚举的运行时值。
 */
const HIT_TYPE = {
  Normal: 1,
  Slider: 2,
  NewCombo: 4,
  Spinner: 8,
  Hold: 128,
} as const;

/**
 * 解析 `.osu`。
 *
 * ⚠️ 与 `loadReplay` 不同,`BeatmapDecoder.decodeFromBuffer` 是**同步**的
 * (`ScoreDecoder` 才是 async)。这里仍写成 async 是因为解析器走动态 `import()`。
 *
 * ✅ 已验证(2026-08-23):4 个真实 `.osu`(fileFormat 14)全部解析成功,1~10 ms。
 */
export async function loadBeatmap(data: ArrayBuffer): Promise<LoadedBeatmap> {
  const { BeatmapDecoder } = await import('osu-parsers');

  // 第二参 false = 不解故事板。故事板与模拟无关,跳过省时间。
  const raw = new BeatmapDecoder().decodeFromBuffer(new Uint8Array(data), false);

  if (raw.originalMode !== MODE_OSU_STD) {
    throw new Error(
      `只支持 osu!std(mode 0),该谱面是 mode ${raw.originalMode}。` +
        'taiko / catch / mania 的判定与物件模型完全不同,不在本项目范围内。',
    );
  }

  return {
    beatmap: toSimBeatmap(raw),
    metadata: extractMetadata(raw),
    raw,
  };
}

function toSimBeatmap(raw: Beatmap): SimBeatmap {
  const difficulty = toDifficulty(raw);

  return {
    hitObjects: toSimHitObjects(
      raw.hitObjects,
      difficulty,
      raw.fileFormat,
      raw.general.stackLeniency,
      raw.controlPoints,
    ),
    breaks: toBreaks(raw),
    difficulty,
    audioLeadIn: raw.general.audioLeadIn,
    stackLeniency: raw.general.stackLeniency,
  };
}

/**
 * 物件转换 + **combo 信息推算** + **堆叠**。
 *
 * ⚠️ osu-parsers **不填** combo 索引:`currentComboIndex` / `indexInCombo`
 * 实测恒为 `undefined`,只有 `isNewCombo` / `comboOffset` 是解析出来的。
 * 所以这里必须自己走一遍 lazer 的 `UpdateComboInformation` 逻辑。
 *
 * 堆叠同理:osu-parsers 不算 `stackHeight`,见 `sim/stacking.ts`;
 * 滑条刻度数也不算,见 `sim/sliderParts.ts`。
 */
function toSimHitObjects(
  objects: readonly HitObject[],
  difficulty: Difficulty,
  fileFormat: number,
  stackLeniency: number,
  controlPoints: ControlPointInfo,
): SimHitObject[] {
  // 解析器给的顺序理论上按 startTime,但不假定 —— 判定与视觉索引都依赖有序
  const sorted = [...objects].sort((a, b) => a.startTime - b.startTime);

  const forced = forceNewCombos(sorted);

  // Pass 1:先摊平成堆叠算法需要的形状(它只要位置与时间)
  const flat = sorted.map<StackableObject & { readonly spans: number; readonly tickCount: number }>(
    (o) => {
      const kind = kindOf(o);
      const spans = spansOf(o, kind);
      const end = endPositionOf(o, kind, spans);

      return {
        kind,
        startTime: o.startTime,
        endTime: endTimeOf(o, kind),
        x: o.startPosition.x,
        y: o.startPosition.y,
        endX: end.x,
        endY: end.y,
        spans,
        tickCount: tickCountFor(o, kind, spans, controlPoints, difficulty.sliderTickRate),
      };
    },
  );

  // Pass 2:堆叠。必须在全部物件就位后算 —— 它要前后互相参照
  const heights = computeStackHeights(flat, {
    stackLeniency,
    // lazer 的阈值用 (int)TimePreempt,而 preemptFromAR 已经取整
    timePreempt: preemptFromAR(difficulty.approachRate),
    fileFormat,
  });

  // Scale = Radius / OBJECT_RADIUS。堆叠偏移是 stackHeight * scale * -6.4
  const scale = radiusFromCS(difficulty.circleSize) / OBJECT_RADIUS;

  // Pass 3:合成最终物件(combo 递推 + 堆叠偏移)
  const out: SimHitObject[] = [];
  let comboIndex = -1;
  let indexInCombo = 0;

  for (let i = 0; i < flat.length; i++) {
    const f = flat[i]!;
    const newCombo = forced[i]!;

    // lazer `UpdateComboInformation`:新 combo 时 index++ 且 inCombo 归零,
    // 否则 inCombo 递增。第一个物件必然进入新 combo 分支(见 forceNewCombos)。
    if (newCombo) {
      comboIndex++;
      indexInCombo = 0;
    } else {
      indexInCombo++;
    }

    const stackHeight = heights[i]!;
    const offset = stackOffset(stackHeight, scale);

    out.push({
      kind: f.kind,
      startTime: f.startTime,
      endTime: f.endTime,
      x: f.x,
      y: f.y,
      endX: f.endX,
      endY: f.endY,
      stackHeight,
      stackedX: f.x + offset,
      stackedY: f.y + offset,
      spans: f.spans,
      tickCount: f.tickCount,
      newCombo,
      comboIndex,
      // 圈内数字从 1 开始,而 lazer 的 IndexInCurrentCombo 从 0 开始
      indexInCombo: indexInCombo + 1,
    });
  }

  return out;
}

/**
 * 滑条刻度数。
 *
 * 需要该滑条起点处生效的(**非继承**)timing point 的 `beatLength` ——
 * `controlPoints.timingPointAt()` 给的就是它。刻度公式见 `sim/sliderParts.ts`。
 */
function tickCountFor(
  o: HitObject,
  kind: HitObjectKind,
  spans: number,
  controlPoints: ControlPointInfo,
  sliderTickRate: number,
): number {
  if (kind !== 'slider') return 0;

  const slider = o as unknown as {
    readonly velocity?: unknown;
    readonly path?: { readonly distance?: unknown };
  };

  const velocity = slider.velocity;
  const pathDistance = slider.path?.distance;

  if (typeof velocity !== 'number' || !Number.isFinite(velocity) || velocity <= 0) return 0;
  if (typeof pathDistance !== 'number' || !Number.isFinite(pathDistance)) return 0;

  const beatLength = controlPoints.timingPointAt(o.startTime)?.beatLength;
  if (typeof beatLength !== 'number' || !Number.isFinite(beatLength) || beatLength <= 0) return 0;

  return tickCountOf({ pathDistance, velocity, spans, beatLength, sliderTickRate });
}

/** 滑条的 span 数 = repeat + 1。circle / spinner 恒为 1。 */function spansOf(o: HitObject, kind: HitObjectKind): number {
  if (kind !== 'slider') return 1;

  const spans = (o as unknown as { readonly spans?: unknown }).spans;
  if (typeof spans === 'number' && Number.isFinite(spans) && spans >= 1) return spans;

  // 退回 repeats + 1
  const repeats = (o as unknown as { readonly repeats?: unknown }).repeats;
  return typeof repeats === 'number' && Number.isFinite(repeats) ? repeats + 1 : 1;
}

/**
 * 物件末端位置(未堆叠)。
 *
 * circle / spinner 等于起点。slider 是 `startPosition + path.curvePositionAt(1, spans)`
 * —— 对应 lazer 的 `Slider.EndPosition => Position + this.CurvePositionAt(1)`。
 *
 * ⚠️ `curvePositionAt` **考虑 repeat**:偶数 span 的滑条(来回一趟)末端会回到
 * 起点。堆叠算法用末端位置判断"圈是否落在滑条尾上",所以这个细节会影响结果。
 */
function endPositionOf(
  o: HitObject,
  kind: HitObjectKind,
  spans: number,
): { readonly x: number; readonly y: number } {
  if (kind !== 'slider') return { x: o.startPosition.x, y: o.startPosition.y };

  const path = (o as unknown as {
    readonly path?: { curvePositionAt?: (progress: number, spans: number) => Vector2 };
  }).path;

  if (!path || typeof path.curvePositionAt !== 'function') {
    throw new Error(
      `slider 在 startTime=${o.startTime} 处没有可用的 path.curvePositionAt()。` +
        '堆叠与滑条渲染都依赖它,请检查 osu-parsers 版本。',
    );
  }

  const relative = path.curvePositionAt(1, spans);
  return { x: o.startPosition.x + relative.x, y: o.startPosition.y + relative.y };
}

/**
 * 补上 lazer `OsuBeatmapProcessor.PreProcess()` 强制的 new combo。
 *
 * 规则:**第一个非转盘物件**、以及**紧跟在转盘之后的第一个非转盘物件**,
 * 一律视为新 combo —— 即使 `.osu` 文件里没有置 NewCombo 位。
 *
 * lazer 的注释说明原因:legacy 解码器通常保证了这一点,但编辑器不强制,
 * 所以要在这里兜底。漏掉这一步会让 combo 编号与圈内数字整体错位。
 */
function forceNewCombos(sorted: readonly HitObject[]): boolean[] {
  const out: boolean[] = [];
  let previous: HitObject | null = null;

  for (const o of sorted) {
    const isSpinner = (o.hitType & HIT_TYPE.Spinner) !== 0;
    const previousWasSpinner =
      previous !== null && (previous.hitType & HIT_TYPE.Spinner) !== 0;

    const forced = !isSpinner && (previous === null || previousWasSpinner);
    out.push(forced || (o.hitType & HIT_TYPE.NewCombo) !== 0);

    previous = o;
  }

  // 第一个物件必然开启 combo:lazer 的 `UpdateComboInformation(lastObj)` 在
  // `lastObj == null` 时无条件走新 combo 分支。若首个物件是转盘,上面的
  // `!isSpinner` 会把它漏掉,而 comboIndex 会停在 -1 —— 所以这里强制置位。
  if (out.length > 0) out[0] = true;

  return out;
}

function kindOf(o: HitObject): HitObjectKind {
  if (o.hitType & HIT_TYPE.Spinner) return 'spinner';
  if (o.hitType & HIT_TYPE.Slider) return 'slider';
  if (o.hitType & HIT_TYPE.Normal) return 'circle';

  throw new Error(
    `无法识别的 hitType 位域 ${o.hitType}(0b${o.hitType.toString(2)}),` +
      `startTime=${o.startTime}。` +
      ((o.hitType & HIT_TYPE.Hold) !== 0
        ? 'Hold(128)是 mania 的长条,不应出现在 std 谱面里。'
        : ''),
  );
}

/**
 * 物件结束时刻。
 *
 * circle 上等于 startTime;spinner 有显式 `endTime`;slider 的 `endTime` 是
 * osu-parsers 算好的 getter(由 `distance / velocity` 推出,实测已可用)。
 *
 * 类型上取不到:`endTime` 只存在于 osu-parsers 的 `SlidableObject` /
 * `SpinnableObject` 具体类上,而 `Beatmap.hitObjects` 的静态类型是基类
 * `HitObject[]`(osu-classes 只导出 `ISlidableObject` 这类接口)。
 * 所以这里按结构断言 + 运行时校验,而不是硬转成某个具体类。
 */
function endTimeOf(o: HitObject, kind: HitObjectKind): number {
  if (kind === 'circle') return o.startTime;

  const endTime = (o as unknown as { readonly endTime?: unknown }).endTime;
  if (typeof endTime !== 'number' || !Number.isFinite(endTime)) {
    throw new Error(
      `${kind} 在 startTime=${o.startTime} 处没有可用的 endTime(得到 ${String(endTime)})。` +
        '可能是解析器未算出滑条速度,或物件类型判别有误。',
    );
  }

  // 极短滑条可能算出 endTime < startTime 的退化情况,夹一下免得视觉窗口反向
  return Math.max(o.startTime, endTime);
}

function toBreaks(raw: Beatmap): BreakPeriod[] {
  return raw.events.breaks.map((b) => ({ start: b.startTime, end: b.endTime }));
}

/**
 * 难度参数。
 *
 * ⚠️ 这些值在 `.osu` 里是十进制文本,但 osu-parsers 存成 float32,取出来
 * 会看到 `9.300000190734863`(AR 9.3)、`3.700000047683716`(CS 3.7)这样的值。
 * **不要四舍五入** —— lazer 同样以单精度参与后续计算,取整反而会偏离。
 */
function toDifficulty(raw: Beatmap): Difficulty {
  const d = raw.difficulty;

  return {
    circleSize: d.circleSize,
    approachRate: d.approachRate,
    overallDifficulty: d.overallDifficulty,
    drainRate: d.drainRate,
    sliderMultiplier: d.sliderMultiplier,
    sliderTickRate: d.sliderTickRate,
  };
}

function extractMetadata(raw: Beatmap): BeatmapMetadata {
  const m = raw.metadata;

  return {
    title: m.title,
    artist: m.artist,
    creator: m.creator,
    version: m.version,
    beatmapId: m.beatmapId,
    beatmapSetId: m.beatmapSetId,
    audioFilename: raw.general.audioFilename,
    fileFormat: raw.fileFormat,
  };
}

/** 便于测试与调试:统计各类物件数量。 */
export function countByKind(beatmap: SimBeatmap): Record<HitObjectKind, number> {
  const counts: Record<HitObjectKind, number> = { circle: 0, slider: 0, spinner: 0 };
  for (const o of beatmap.hitObjects) counts[o.kind]++;
  return counts;
}
