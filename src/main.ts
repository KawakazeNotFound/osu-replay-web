/**
 * M0 spike 的入口。
 *
 * 这个文件的目的是**验证架构**,不是做产品:
 * 1. 验证 osu-parsers 能否在浏览器里解出 .osr 的 LZMA 回放帧(TECH-NOTES A1)
 * 2. 验证「AudioClock → stateAt → 无状态渲染」这条链路在任意 seek 下都正确
 * 3. 把快进 / 快退 / 暂停 / 倍速 / 逐帧 五个操作全部跑通
 *
 * M1 起 UI 会重做,但 core/ 里的模块应当原样保留。
 */

import { AudioClock } from './core/clock/AudioClock';
import {
  autoFetchBeatmap,
  describeStage,
  type AutoFetchedBeatmap,
} from './core/load/autoFetch';
import { md5OfBuffer } from './core/load/beatmapHash';
import {
  countByKind,
  loadBeatmap,
  type LoadedBeatmap,
} from './core/load/beatmapLoader';
import {
  loadReplay,
  speedMultiplierOfLegacyMods,
  type LoadedReplay,
  type ReplayInfoSummary,
} from './core/load/replayLoader';
import { EMPTY_FRAMES, ReplayKey, normalizeKeys } from './core/replay/frames';
import { createCircleJudgement } from './core/sim/judgement';
import { stateAt } from './core/sim/query';
import { buildTimeline, emptyTimeline, placeholderBeatmap } from './core/sim/timeline';
import { PlaybackController } from './player/PlaybackController';
import { DebugRenderer } from './render/DebugRenderer';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 元素 #${id}`);
  return node as T;
}

const canvas = el<HTMLCanvasElement>('canvas');
const statusEl = el<HTMLParagraphElement>('status');
const scrubber = el<HTMLInputElement>('scrubber');
const playButton = el<HTMLButtonElement>('play');
const rateSelect = el<HTMLSelectElement>('rate');
const autoFetchEnabled = el<HTMLInputElement>('auto-fetch');

const audioContext = new AudioContext();
const clock = new AudioClock(audioContext);
const controller = new PlaybackController(clock, emptyTimeline());
const renderer = new DebugRenderer(canvas);

/** 拖动进度条期间暂停自动回写,否则会和用户的输入打架。 */
let scrubbing = false;
let replayLoaded = false;
let audioLoaded = false;

/**
 * 当前载入的谱面与回放。
 *
 * 两者**独立**:只有回放也能播(光标轨迹 + 时钟,这是 M0 验证过的路径),
 * 只有谱面也能看物件排布。任一变化就重建时间线 —— 时间线是不可变的,
 * 重建成本 <100ms,没必要做增量更新。
 */
let currentBeatmap: LoadedBeatmap | null = null;
let currentReplay: LoadedReplay | null = null;

/** 当前谱面的 MD5,用于与回放头部比对(TECH-NOTES D10)。 */
let currentBeatmapMd5: string | null = null;

/** 最近一次自动获取的结果,供状态栏显示来源。 */
let lastAutoFetch: AutoFetchedBeatmap | null = null;

/** 正在进行的自动下载。换回放时要取消上一个。 */
let autoFetchAbort: AbortController | null = null;

/* ---------------- 载入 ---------------- */

function setStatus(message: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  statusEl.textContent = message;
  statusEl.className = kind === 'info' ? '' : kind;
}

/**
 * 用当前的谱面 + 回放重建时间线。
 *
 * 谱面缺失时退回 `placeholderBeatmap()`(空物件列表 + 默认难度),此时时间轴
 * 范围完全由回放帧决定 —— M0 就是这么跑起来的。
 */
function rebuildTimeline(): void {
  const wasPlaying = controller.isPlaying;
  const previousTime = controller.currentTime;

  controller.pause();
  controller.timeline = buildTimeline(
    currentBeatmap?.beatmap ?? placeholderBeatmap(),
    currentReplay?.frames ?? EMPTY_FRAMES,
    // 只有谱面与回放都在时才判定 —— 缺任一方判定无从谈起
    currentBeatmap && currentReplay ? { judge: createCircleJudgement() } : {},
  );

  // 换素材时保持当前时刻,除非它落到了新范围之外
  const { startTime, endTime } = controller.timeline;
  controller.seek(
    previousTime >= startTime && previousTime <= endTime ? previousTime : startTime,
  );

  syncScrubberRange();
  if (wasPlaying) controller.togglePlay();
}

async function loadOsrFile(file: File): Promise<void> {
  setStatus(`正在解析 ${file.name} …`);
  await applyReplay(await file.arrayBuffer());
}

async function loadOsuFile(file: File): Promise<void> {
  setStatus(`正在解析 ${file.name} …`);
  await applyBeatmap(await file.arrayBuffer());
}

/**
 * 开发便利:`?osr=/fixtures/stable.osr&osu=/fixtures/stable.osu&t=30000`
 * 会在启动时自动载入并跳到该时刻。
 *
 * 免得每次热重载都要重新点一遍文件选择框、再拖回原来的位置,也让 headless
 * 浏览器验收能无人值守地跑起来(文件输入框没法从脚本填)。
 */
async function autoLoadFromQuery(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const osr = params.get('osr');
  const osu = params.get('osu');
  if (!osr && !osu) return;

  for (const [url, apply] of [
    [osu, applyBeatmap] as const,
    [osr, applyReplay] as const,
  ]) {
    if (!url) continue;

    setStatus(`正在载入 ${url} …`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        setStatus(`载入失败:HTTP ${response.status} ${url}`, 'error');
        return;
      }
      await apply(await response.arrayBuffer());
    } catch (error) {
      setStatus(
        `载入 ${url} 失败:${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      return;
    }
  }

  const t = Number(params.get('t'));
  if (params.has('t') && Number.isFinite(t)) controller.seek(t);
}

async function applyBeatmap(buffer: ArrayBuffer): Promise<void> {
  try {
    currentBeatmap = await loadBeatmap(buffer);
    // 记下手动上传谱面的 MD5,用于与回放比对(TECH-NOTES D10)
    currentBeatmapMd5 = md5OfBuffer(buffer);
    rebuildTimeline();
    showBeatmapInfo(currentBeatmap);
    setStatus(describeLoaded(), 'ok');
    console.log('[spike] 谱面原始对象:', currentBeatmap.raw);
  } catch (error) {
    reportFailure('.osu 解析失败', error);
  }
}

async function applyReplay(buffer: ArrayBuffer): Promise<void> {
  try {
    currentReplay = await loadReplay(buffer);
    // mod 倍率随回放变化,必须每次重设 —— 否则上一段 DT 回放的倍率会漏过来
    controller.setModRate(speedMultiplierOfLegacyMods(currentReplay.info.rawMods));
    rebuildTimeline();

    showReplayInfo(currentReplay.info);
    replayLoaded = true;
    setControlsEnabled(true);

    setStatus(describeLoaded(), 'ok');
    console.log('[spike] 回放原始 Score:', currentReplay.raw);
  } catch (error) {
    reportFailure('.osr 解析失败', error);
    return;
  }

  // 回放载入成功后自动去取谱面。失败不影响已经能播的光标轨迹。
  if (autoFetchEnabled.checked) await autoFetchForCurrentReplay();
}

/**
 * 按当前回放的谱面哈希自动取回谱面与音频。
 *
 * ⚠️ 依赖外部镜像站(见 `core/load/mirror.ts`)。失败时**不清空已载入的回放**
 * —— 光标轨迹本身已经能播,退回手动上传即可。
 */
async function autoFetchForCurrentReplay(): Promise<void> {
  const replay = currentReplay;
  if (!replay) return;

  // 已经手动载入了正确的谱面就不必再下载
  if (currentBeatmap && currentBeatmapMd5 === replay.info.beatmapHashMD5) return;

  // 取消上一次未完成的下载 —— 用户可能连续换了两个回放
  autoFetchAbort?.abort();
  const abort = new AbortController();
  autoFetchAbort = abort;

  try {
    const fetched = await autoFetchBeatmap(replay.info.beatmapHashMD5, {
      signal: abort.signal,
      onStage: (stage) => setStatus(`${describeStage(stage)}\n\n${describeLoaded()}`),
    });

    currentBeatmap = fetched.beatmap;
    currentBeatmapMd5 = replay.info.beatmapHashMD5;
    lastAutoFetch = fetched;

    rebuildTimeline();
    showBeatmapInfo(fetched.beatmap);

    if (fetched.audio) {
      await decodeAndSetAudio(
        fetched.audio.bytes.buffer.slice(
          fetched.audio.bytes.byteOffset,
          fetched.audio.bytes.byteOffset + fetched.audio.bytes.byteLength,
        ) as ArrayBuffer,
        fetched.audio.name,
      );
    }

    setStatus(describeLoaded(), 'ok');
    console.log('[spike] 自动取回的谱面包:', fetched);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;

    const detail = error instanceof Error ? error.message : String(error);
    setStatus(
      `⚠️ 自动获取谱面失败,但回放本身已载入(可播光标轨迹)。\n\n${detail}\n\n` +
        `可以手动上传 .osu 与音频继续。\n\n${describeLoaded()}`,
      'error',
    );
    console.warn('[spike] 自动取谱面失败:', error);
  } finally {
    if (autoFetchAbort === abort) autoFetchAbort = null;
  }
}

function reportFailure(what: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause ? `\n\n底层原因:${String(error.cause)}` : '';

  setStatus(`❌ ${what}\n\n${detail}${cause}`, 'error');
  console.error(`[spike] ${what}:`, error);
}

/** 状态栏文案。谱面与回放各自可缺,所以逐项拼。 */
function describeLoaded(): string {
  const lines: string[] = ['✅ 载入成功', ''];

  if (currentBeatmap) {
    const { metadata, beatmap } = currentBeatmap;
    const counts = countByKind(beatmap);
    lines.push(
      `谱面:${metadata.artist} - ${metadata.title} [${metadata.version}]`,
      `  ${beatmap.hitObjects.length} 个物件` +
        `(circle ${counts.circle} / slider ${counts.slider} / spinner ${counts.spinner})`,
      `  CS ${fmt(beatmap.difficulty.circleSize)} AR ${fmt(beatmap.difficulty.approachRate)} ` +
        `OD ${fmt(beatmap.difficulty.overallDifficulty)} HP ${fmt(beatmap.difficulty.drainRate)}`,
    );
  } else {
    lines.push('谱面:未载入(只播光标轨迹)');
  }

  if (currentReplay) {
    const { info, frames } = currentReplay;
    lines.push(
      `回放:${info.playerName} — ${info.isLazer ? 'lazer' : 'stable'},mods ${info.mods}`,
      `  ${frames.count} 个回放帧`,
    );
  } else {
    lines.push('回放:未载入');
  }

  lines.push(audioLoaded ? '音频:已载入(音画同步可用)' : '音频:未载入(只有画面,时钟自由运行)');

  lines.push(
    '',
    `时间范围 ${formatTime(controller.timeline.startTime)} → ` +
      `${formatTime(controller.timeline.endTime)}`,
  );

  if (currentBeatmap && currentReplay) {
    // D10:现在真的能校验了 —— 有 MD5 实现
    const wanted = currentReplay.info.beatmapHashMD5;
    if (currentBeatmapMd5 === null) {
      lines.push('', `⚠️ 未能算出当前谱面的 MD5,无法校验是否与回放匹配。`);
    } else if (currentBeatmapMd5 === wanted) {
      lines.push('', `✅ 谱面与回放匹配(MD5 ${wanted.slice(0, 8)}…)`);
    } else {
      lines.push(
        '',
        `❌ **谱面与回放不匹配!**`,
        `  回放要的:${wanted}`,
        `  当前谱面:${currentBeatmapMd5}`,
        `  物件与判定会完全错位。请换成正确的难度。`,
      );
    }
  }

  if (lastAutoFetch && currentBeatmap === lastAutoFetch.beatmap) {
    const f = lastAutoFetch;
    lines.push(
      '',
      `谱面来源:${f.mirror.name} 自动获取` +
        `(beatmapset ${f.lookup.beatmapSetId},${f.lookup.status},包 ${
          (f.oszBytes / 1024 / 1024).toFixed(1)
        } MB)`,
      `  音频:${f.audio ? f.audio.name : '❌ 包内未找到'}`,
    );
  }

  if (currentReplay) {
    const notice = modRateNotice(currentReplay.info.rawMods);
    if (notice) lines.push('', notice.trim());
  }

  return lines.join('\n');
}

/** 难度值去掉浮点噪声:osu-parsers 存 float32,AR 9.3 会读出 9.300000190734863。 */
function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

async function loadAudioFile(file: File): Promise<void> {
  await decodeAndSetAudio(await file.arrayBuffer(), file.name);
}

/** 解码音频并挂到时钟上。自动获取与手动上传走同一条路。 */
async function decodeAndSetAudio(buffer: ArrayBuffer, label: string): Promise<void> {
  try {
    // decodeAudioData 会**吞掉**传入的 buffer(detach),所以给它一份拷贝 ——
    // 否则同一份字节想再用(比如换设备重新解码)就会拿到长度 0 的 buffer
    const decoded = await audioContext.decodeAudioData(buffer.slice(0));
    clock.setBuffer(decoded);
    audioLoaded = true;
    console.log(`[spike] 音频已载入 ${label}:${decoded.duration.toFixed(2)}s`);
  } catch (error) {
    setStatus(
      `音频解码失败(${label}):${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}

function showBeatmapInfo(loaded: LoadedBeatmap): void {
  const { metadata, beatmap } = loaded;
  const counts = countByKind(beatmap);
  const d = beatmap.difficulty;

  el('v-map').textContent = `${metadata.artist} - ${metadata.title}`;
  el('v-diff').textContent = metadata.version;
  el('v-mapper').textContent = metadata.creator;
  el('v-objects').textContent =
    `${beatmap.hitObjects.length} (${counts.circle}/${counts.slider}/${counts.spinner})`;
  el('v-stats').textContent =
    `CS ${fmt(d.circleSize)} AR ${fmt(d.approachRate)} OD ${fmt(d.overallDifficulty)} HP ${fmt(d.drainRate)}`;
}

function showReplayInfo(info: ReplayInfoSummary): void {
  el('v-player').textContent = info.playerName;
  el('v-rawscore').textContent = info.totalScore.toLocaleString();
  el('v-rawcombo').textContent = String(info.maxCombo);
  el('v-rawcounts').textContent =
    `${info.count300}/${info.count100}/${info.count50}/${info.countMiss}`;
  el('v-rawmods').textContent = info.mods;
  el('v-source').textContent =
    `${info.isLazer ? 'lazer' : 'stable'} (${info.gameVersion})`;
  el('v-framecount').textContent = String(info.frameCount);
}

/**
 * 变速 mod 的说明。
 *
 * 回放帧时间戳是谱面时间,DT 的含义是谱面时间相对真实时间跑得更快。载入时会把
 * 这个倍率设进时钟(见 `controller.setModRate`),所以"1×"表示按玩家当时的
 * 实际节奏播。
 */
function modRateNotice(rawMods: number): string {
  const multiplier = speedMultiplierOfLegacyMods(rawMods);
  if (multiplier === 1) return '';

  return (
    `⏩ 该回放带变速 mod,已按 ${multiplier}× 推进谱面时间。` +
    `倍速选择器是在此之上再乘。\n\n`
  );
}

/* ---------------- 控件 ---------------- */

const STEP_BUTTONS: readonly (readonly [string, () => void])[] = [
  ['back-5s', () => controller.skip(-5000)],
  ['back-1s', () => controller.skip(-1000)],
  ['fwd-1s', () => controller.skip(1000)],
  ['fwd-5s', () => controller.skip(5000)],
  ['prev-frame', () => controller.stepDisplayFrame(-1)],
  ['next-frame', () => controller.stepDisplayFrame(1)],
  ['prev-input', () => controller.stepReplayFrame(-1)],
  ['next-input', () => controller.stepReplayFrame(1)],
];

function setControlsEnabled(enabled: boolean): void {
  playButton.disabled = !enabled;
  scrubber.disabled = !enabled;
  for (const [id] of STEP_BUTTONS) el<HTMLButtonElement>(id).disabled = !enabled;
}

function syncScrubberRange(): void {
  scrubber.min = String(Math.floor(controller.timeline.startTime));
  scrubber.max = String(Math.ceil(controller.timeline.endTime));
  scrubber.value = String(Math.floor(controller.currentTime));
}

function wireControls(): void {
  el<HTMLInputElement>('osu-input').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void loadOsuFile(file);
  });

  el<HTMLInputElement>('osr-input').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void loadOsrFile(file);
  });

  el<HTMLInputElement>('audio-input').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void loadAudioFile(file);
  });

  playButton.addEventListener('click', () => controller.togglePlay());

  for (const [id, action] of STEP_BUTTONS) {
    el<HTMLButtonElement>(id).addEventListener('click', action);
  }

  rateSelect.addEventListener('change', () => {
    controller.setRate(Number(rateSelect.value));
  });

  scrubber.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  scrubber.addEventListener('pointerup', () => {
    scrubbing = false;
  });
  scrubber.addEventListener('input', () => {
    controller.seek(Number(scrubber.value));
  });

  window.addEventListener('keydown', (event) => {
    if (!replayLoaded || event.target instanceof HTMLInputElement) return;

    const handler = KEY_ACTIONS[event.key];
    if (!handler) return;

    event.preventDefault();
    handler();
  });

  window.addEventListener('resize', () => renderer.resize());
}

const KEY_ACTIONS: Record<string, (() => void) | undefined> = {
  ' ': () => controller.togglePlay(),
  ArrowLeft: () => controller.skip(-1000),
  ArrowRight: () => controller.skip(1000),
  ArrowDown: () => controller.skip(-5000),
  ArrowUp: () => controller.skip(5000),
  ',': () => controller.stepDisplayFrame(-1),
  '.': () => controller.stepDisplayFrame(1),
  ';': () => controller.stepReplayFrame(-1),
  "'": () => controller.stepReplayFrame(1),
};

/* ---------------- 渲染循环 ---------------- */

let lastFrameStamp = 0;
let smoothedFps = 0;

function tick(stamp: number): void {
  if (lastFrameStamp > 0) {
    const delta = stamp - lastFrameStamp;
    if (delta > 0) smoothedFps = smoothedFps * 0.9 + (1000 / delta) * 0.1;
  }
  lastFrameStamp = stamp;

  const { timeline } = controller;
  const time = controller.clampedTime;

  // 播到末尾自动停,免得时钟无限往前跑
  if (controller.isPlaying && controller.currentTime >= timeline.endTime) {
    controller.pause();
  }

  const state = stateAt(timeline, time);
  renderer.draw(timeline, state);
  updateHud(state, time);

  requestAnimationFrame(tick);
}

function updateHud(state: ReturnType<typeof stateAt>, time: number): void {
  playButton.textContent = controller.isPlaying ? '暂停' : '播放';

  el('v-time').textContent = formatTime(time);
  el('v-rate').textContent =
    controller.modRate === 1
      ? `${controller.userRate}×`
      : `${controller.userRate}× × mod ${controller.modRate}× = ${
          Math.round(controller.rate * 1000) / 1000
        }×`;
  el('v-running').textContent = controller.isPlaying ? '是' : '否';
  el('v-fps').textContent = smoothedFps > 0 ? smoothedFps.toFixed(0) : '—';

  el('v-pos').textContent = `${state.cursor.x.toFixed(1)}, ${state.cursor.y.toFixed(1)}`;
  el('v-keys').textContent = describeKeys(state.cursor.keys);
  el('v-frame').textContent =
    state.cursor.frameIndex >= 0
      ? `${state.cursor.frameIndex} / ${controller.timeline.frames.count}`
      : '—';

  el('v-score').textContent = state.score.toLocaleString();
  el('v-combo').textContent = `${state.combo} (max ${state.maxCombo})`;
  el('v-acc').textContent = `${(state.accuracy * 100).toFixed(2)}%`;
  el('v-hp').textContent = `${(state.hp * 100).toFixed(0)}%`;

  if (!scrubbing) scrubber.value = String(Math.floor(time));
}

function describeKeys(keys: number): string {
  const normalized = normalizeKeys(keys);
  const pressed: string[] = [];
  if (normalized & ReplayKey.M1) pressed.push('K1/M1');
  if (normalized & ReplayKey.M2) pressed.push('K2/M2');
  if (keys & ReplayKey.Smoke) pressed.push('Smoke');
  return pressed.length > 0 ? pressed.join(' + ') : '—';
}

function formatTime(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  const millis = Math.floor(abs % 1000);
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/* ---------------- 启动 ---------------- */

wireControls();
renderer.resize();
requestAnimationFrame(tick);
void autoLoadFromQuery();
