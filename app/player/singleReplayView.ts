/**
 * In-page Single Replay & Auto Play setup wizard screen (osu!lazer resources & wizard style).
 *
 * Supports:
 * - Drag-and-drop .osr files directly with automatic MD5 hash lookup and beatmap set download
 * - Optional local .osz / .osu file attachment for unranked/offline maps
 * - Direct score URL, beatmap URL, and numeric ID input
 * - High-polish lazer UI layout with section tabs, drop zones, and crisp flat parallelogram buttons
 */

import { icon, type IconName } from '../results/icons.js';
import { uiSounds, type UiSampleName } from './uiSounds.js';
import { t, isZh } from './i18n.js';

export interface SingleReplayViewOptions {
  readonly host: HTMLElement;
  readonly onExit: () => void;
  readonly onLoadOsr: (osrFile: File, oszFile: File | null) => Promise<void>;
  readonly onLoadAutoOsz: (oszFile: File) => Promise<void>;
  readonly onLoadUrl: (input: string) => Promise<void>;
}

export interface SingleReplayViewHandle {
  readonly root: HTMLElement;
  open(mode: 'replay' | 'auto'): void;
  close(): void;
  setStatus(msg: string, type?: 'info' | 'loading' | 'error' | 'success'): void;
  setPendingFiles(osr: File | null, osz: File | null): void;
  handleProgress(msg: string): void;
  finishProgress(): Promise<void>;
  resetProgress(): void;
  destroy(): void;
}

let singleReplayCssInjected = false;

function ensureSingleReplayCss(): void {
  if (singleReplayCssInjected) return;
  const style = document.createElement('style');
  style.textContent = singleReplayCss();
  document.head.append(style);
  singleReplayCssInjected = true;
}

export function buildSingleReplayView(options: SingleReplayViewOptions): SingleReplayViewHandle {
  ensureSingleReplayCss();

  let currentMode: 'replay' | 'auto' = 'replay';
  let pendingOsr: File | null = null;
  let pendingOsz: File | null = null;

  const root = document.createElement('div');
  root.className = 'rv-replay-setup-screen';
  root.hidden = true;

  const setupContent = document.createElement('div');
  setupContent.className = 'rv-replay-setup-content';

  // 1. Top Hanging Header Banner Card
  const setupHeader = document.createElement('div');
  setupHeader.className = 'rv-replay-dialog-header';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'rv-replay-dialog-header-left';

  const titleIcon = document.createElement('span');
  titleIcon.className = 'rv-replay-title-icon';
  titleIcon.append(icon('mode-single', { className: 'rv-icon' }));

  const headerTextWrap = document.createElement('div');
  headerTextWrap.className = 'rv-replay-dialog-header-text';

  const headerTitle = document.createElement('h3');
  headerTitle.className = 'rv-replay-dialog-title';
  headerTitle.textContent = t('单人回放', 'Single Replay');

  const headerSub = document.createElement('p');
  headerSub.className = 'rv-replay-dialog-subtitle';
  headerSub.textContent = t('和全世界的玩家一起重温精彩对决！', 'Relive incredible plays from players worldwide!');

  headerTextWrap.append(headerTitle, headerSub);
  headerLeft.append(titleIcon, headerTextWrap);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rv-replay-dialog-close-btn';
  closeBtn.title = t('关闭并返回主页', 'Close');
  closeBtn.append(icon('close', { className: 'rv-icon' }));
  uiSounds.attachHoverClick(closeBtn, { hover: 'button', click: false });
  closeBtn.addEventListener('click', () => {
    uiSounds.playClick('dialog-cancel');
    root.hidden = true;
    options.onExit();
  });

  setupHeader.append(headerLeft, closeBtn);

  // 2. Main Content Card
  const setupBody = document.createElement('div');
  setupBody.className = 'rv-replay-dialog-body';

  // Section tab header ("资源" with mint underline)
  const tabHeader = document.createElement('div');
  tabHeader.className = 'rv-replay-section-tab-bar';

  const tabItem = document.createElement('div');
  tabItem.className = 'rv-replay-section-tab active';
  const tabText = document.createElement('span');
  tabText.className = 'rv-replay-tab-text';
  tabText.textContent = t('资源', 'Resources');
  const tabLine = document.createElement('div');
  tabLine.className = 'rv-replay-tab-line';
  tabItem.append(tabText, tabLine);
  tabHeader.append(tabItem);

  // Hidden file inputs
  const osrInput = document.createElement('input');
  osrInput.type = 'file';
  osrInput.accept = '.osr';
  osrInput.style.display = 'none';

  const oszInput = document.createElement('input');
  oszInput.type = 'file';
  oszInput.accept = '.osz,.osu,.zip';
  oszInput.style.display = 'none';

  // Main Drop Card (for .osr or .osz depending on mode)
  const mainDropCard = document.createElement('div');
  mainDropCard.className = 'rv-replay-drop-card';

  const dropHero = document.createElement('div');
  dropHero.className = 'rv-replay-drop-hero';

  const dropIconWrap = document.createElement('div');
  dropIconWrap.className = 'rv-replay-drop-icon-wrap';
  // SVG cursor drop pointer
  dropIconWrap.innerHTML = `
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 4l7 16 2.5-6.5L20 11z" />
      <circle cx="17.5" cy="17.5" r="3.5" fill="currentColor" opacity="0.3" />
      <path d="M17.5 15.5v4M15.5 17.5h4" stroke-width="1.8" />
    </svg>
  `;

  const dropPrompt = document.createElement('div');
  dropPrompt.className = 'rv-replay-drop-prompt';
  dropPrompt.textContent = t(
    '把 .osr 回放文件拖至此处来自动查找谱面并播放！',
    'Drag .osr replay file here to automatically fetch beatmap and play!',
  );

  dropHero.append(dropIconWrap, dropPrompt);

  const dropStrip = document.createElement('div');
  dropStrip.className = 'rv-replay-drop-strip';

  const stripInfo = document.createElement('div');
  stripInfo.className = 'rv-replay-strip-info';

  const stripTitle = document.createElement('div');
  stripTitle.className = 'rv-replay-strip-title';
  stripTitle.textContent = t('回放文件 (.osr)', 'Replay file (.osr)');

  const stripSub = document.createElement('div');
  stripSub.className = 'rv-replay-strip-sub';
  stripSub.textContent = t('点击选择 .osr 回放文件', 'Click to select .osr replay file');

  stripInfo.append(stripTitle, stripSub);

  const folderBtn = document.createElement('button');
  folderBtn.type = 'button';
  folderBtn.className = 'rv-replay-folder-btn';
  folderBtn.title = t('选择文件', 'Browse file');
  folderBtn.append(icon('folder', { className: 'rv-icon' }));

  dropStrip.append(stripInfo, folderBtn);
  mainDropCard.append(dropHero, dropStrip);

  // Secondary .osz drop / selection card (optional for replay mode, hidden in auto mode)
  const oszDropCard = document.createElement('div');
  oszDropCard.className = 'rv-replay-drop-card-sub';

  const oszStripInfo = document.createElement('div');
  oszStripInfo.className = 'rv-replay-strip-info';

  const oszStripTitle = document.createElement('div');
  oszStripTitle.className = 'rv-replay-strip-title';
  oszStripTitle.textContent = t('本地谱面文件 (.osz / .osu - 可选)', 'Local beatmap file (.osz / .osu - Optional)');

  const oszStripSub = document.createElement('div');
  oszStripSub.className = 'rv-replay-strip-sub';
  oszStripSub.textContent = t('若为未上架或本地谱面，可在此导入本地谱面包', 'If offline or unranked, import .osz package here');

  oszStripInfo.append(oszStripTitle, oszStripSub);

  const oszFolderBtn = document.createElement('button');
  oszFolderBtn.type = 'button';
  oszFolderBtn.className = 'rv-replay-folder-btn';
  oszFolderBtn.title = t('选择谱面文件', 'Browse beatmap file');
  oszFolderBtn.append(icon('folder', { className: 'rv-icon' }));

  oszDropCard.append(oszStripInfo, oszFolderBtn);

  // Drag & drop handlers for main drop card
  mainDropCard.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    mainDropCard.classList.add('dragover');
  });
  mainDropCard.addEventListener('dragleave', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    mainDropCard.classList.remove('dragover');
  });
  mainDropCard.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    mainDropCard.classList.remove('dragover');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    handleIncomingFiles(Array.from(files));
  });

  mainDropCard.addEventListener('click', () => {
    if (currentMode === 'replay') {
      osrInput.click();
    } else {
      oszInput.click();
    }
  });

  oszDropCard.addEventListener('click', () => {
    oszInput.click();
  });

  osrInput.addEventListener('change', () => {
    if (osrInput.files && osrInput.files.length > 0) {
      handleIncomingFiles(Array.from(osrInput.files));
      osrInput.value = '';
    }
  });

  oszInput.addEventListener('change', () => {
    if (oszInput.files && oszInput.files.length > 0) {
      handleIncomingFiles(Array.from(oszInput.files));
      oszInput.value = '';
    }
  });

  // Online URL / ID input group
  const inputGroup = document.createElement('div');
  inputGroup.className = 'rv-replay-input-group';

  const inputLabel = document.createElement('label');
  inputLabel.className = 'rv-replay-input-label';
  inputLabel.textContent = t('或输入 osu! 成绩链接、谱面链接或纯数字 ID', 'Or enter osu! score URL, beatmap URL or numeric ID');

  const inputWrap = document.createElement('div');
  inputWrap.className = 'rv-replay-input-wrap';

  const inputIcon = document.createElement('span');
  inputIcon.className = 'rv-replay-input-icon';
  inputIcon.append(icon('link', { className: 'rv-icon' }));

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'rv-replay-input-field';
  urlInput.placeholder = t(
    '输入链接 (如 https://osu.ppy.sh/scores/123456 或 123456)',
    'Enter URL (e.g. https://osu.ppy.sh/scores/123456 or 123456)',
  );
  urlInput.autocomplete = 'off';
  urlInput.spellcheck = false;

  inputWrap.append(inputIcon, urlInput);
  inputGroup.append(inputLabel, inputWrap);

  // Status message
  const statusMsg = document.createElement('div');
  statusMsg.className = 'rv-replay-dialog-status';

  // Multi-step loading checklist card (from Image 2)
  const stepsCard = document.createElement('div');
  stepsCard.className = 'rv-replay-steps-card';
  stepsCard.hidden = true;

  interface LoadingStepDef {
    readonly id: string;
    readonly textZh: string;
    readonly textEn: string;
  }

  const STEP_DEFS: LoadingStepDef[] = [
    { id: 'parse', textZh: '准备与解析回放数据……', textEn: 'Preparing & parsing replay data...' },
    { id: 'beatmap', textZh: '正在获取谱面资源 (.osz)……', textEn: 'Fetching beatmap package (.osz)...' },
    { id: 'skin', textZh: '正在载入皮肤与音效资源……', textEn: 'Loading skin & hitsound assets...' },
    { id: 'session', textZh: '正在构建回放渲染引擎……', textEn: 'Building replay session engine...' },
    { id: 'ready', textZh: '即将完成……', textEn: 'Almost ready...' },
  ];

  interface StepRowElement {
    row: HTMLElement;
    text: HTMLElement;
    barWrap: HTMLElement;
    barFill: HTMLElement;
    check: HTMLElement;
    currentProgress: number;
    animFrameId: number | null;
  }

  const stepElements: StepRowElement[] = [];

  for (const step of STEP_DEFS) {
    const row = document.createElement('div');
    row.className = 'rv-replay-step-row state-pending';

    const text = document.createElement('span');
    text.className = 'rv-replay-step-name';
    text.textContent = t(step.textZh, step.textEn);

    const right = document.createElement('div');
    right.className = 'rv-replay-step-right';

    const barWrap = document.createElement('div');
    barWrap.className = 'rv-replay-step-progress-bar';
    barWrap.style.display = 'none';
    const barFill = document.createElement('div');
    barFill.className = 'rv-replay-step-progress-fill';
    barWrap.append(barFill);

    const check = document.createElement('div');
    check.className = 'rv-replay-step-check state-pending';
    check.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;

    right.append(barWrap, check);
    row.append(text, right);
    stepsCard.append(row);

    stepElements.push({
      row,
      text,
      barWrap,
      barFill,
      check,
      currentProgress: 0,
      animFrameId: null,
    });
  }

  let lastProgressSoundTime = 0;

  function stopStepAnimation(index: number): void {
    const el = stepElements[index];
    if (!el) return;
    if (el.animFrameId !== null) {
      cancelAnimationFrame(el.animFrameId);
      el.animFrameId = null;
    }
  }

  function startStepActive(index: number): void {
    const el = stepElements[index];
    if (!el) return;

    stopStepAnimation(index);
    el.row.className = 'rv-replay-step-row state-active';
    el.check.className = 'rv-replay-step-check state-active';
    el.barWrap.style.display = 'block';
    el.barFill.style.transition = 'none';
    el.currentProgress = 0;
    el.barFill.style.width = '0%';

    // Play stage start sound (bss-stage-0, bss-stage-1, etc.)
    const stageSoundName = `bss-stage-${Math.min(index, 3)}` as UiSampleName;
    uiSounds.play(stageSoundName, { volume: 0.8 });

    // Asymptotic non-linear organic creep towards 78%
    const targetProgress = 0.78;
    function frame() {
      const activeEl = stepElements[index];
      if (!activeEl || activeEl.row.className !== 'rv-replay-step-row state-active') return;
      activeEl.currentProgress += (targetProgress - activeEl.currentProgress) * 0.038;
      activeEl.barFill.style.width = `${(activeEl.currentProgress * 100).toFixed(1)}%`;

      const now = performance.now();
      if (now - lastProgressSoundTime > 340 && activeEl.currentProgress < 0.75) {
        lastProgressSoundTime = now;
        const pitch = 1.0 + activeEl.currentProgress * 0.45;
        uiSounds.play('bss-progress', { pitch, volume: 0.4 });
      }

      activeEl.animFrameId = requestAnimationFrame(frame);
    }
    el.animFrameId = requestAnimationFrame(frame);
  }

  function completeStepInstant(index: number): void {
    const el = stepElements[index];
    if (!el) return;

    stopStepAnimation(index);
    el.currentProgress = 1;
    el.barWrap.style.display = 'none';
    el.barFill.style.width = '100%';
    el.row.className = 'rv-replay-step-row state-done';
    el.check.className = 'rv-replay-step-check state-done';
    el.check.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
  }

  function completeStepWithRush(index: number): Promise<void> {
    const el = stepElements[index];
    if (!el) return Promise.resolve();

    stopStepAnimation(index);
    el.barWrap.style.display = 'block';
    el.barFill.style.transition = 'width 180ms cubic-bezier(0.16, 1, 0.3, 1)';
    el.barFill.style.width = '100%';
    el.currentProgress = 1;

    return new Promise(resolve => {
      setTimeout(() => {
        el.barWrap.style.display = 'none';
        el.row.className = 'rv-replay-step-row state-done';
        el.check.className = 'rv-replay-step-check state-done';
        el.check.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
        resolve();
      }, 190);
    });
  }

  function resetSteps(): void {
    stepsCard.hidden = true;
    for (let i = 0; i < stepElements.length; i++) {
      stopStepAnimation(i);
      const el = stepElements[i];
      if (!el) continue;
      el.currentProgress = 0;
      el.row.className = 'rv-replay-step-row state-pending';
      el.check.className = 'rv-replay-step-check state-pending';
      el.barWrap.style.display = 'none';
      el.barFill.style.width = '0%';
      el.check.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
    }
  }

  function startSteps(): void {
    stepsCard.hidden = false;
    currentStepIdx = 0;
    startStepActive(0);
    for (let i = 1; i < stepElements.length; i++) {
      stopStepAnimation(i);
      const el = stepElements[i];
      if (!el) continue;
      el.row.className = 'rv-replay-step-row state-pending';
      el.check.className = 'rv-replay-step-check state-pending';
      el.barWrap.style.display = 'none';
      el.barFill.style.width = '0%';
    }
  }

  let currentStepIdx = 0;

  async function advanceToStep(stepIdx: number): Promise<void> {
    stepsCard.hidden = false;
    if (stepIdx === currentStepIdx) return;

    if (stepIdx > currentStepIdx) {
      for (let i = currentStepIdx; i < stepIdx; i++) {
        await completeStepWithRush(i);
      }
    }
    currentStepIdx = stepIdx;
    if (stepIdx < stepElements.length) {
      startStepActive(stepIdx);
    }
  }

  async function finishAllSteps(): Promise<void> {
    stepsCard.hidden = false;
    for (let i = currentStepIdx; i < stepElements.length; i++) {
      await completeStepWithRush(i);
    }
    for (let i = 0; i < stepElements.length; i++) {
      completeStepInstant(i);
    }
    uiSounds.play('bss-complete', { volume: 0.9 });
    // Wait for the completion animation & bss-complete chime before moving on
    await new Promise(r => setTimeout(r, 480));
  }

  function markStepError(stepIdx: number): void {
    stepsCard.hidden = false;
    stopStepAnimation(stepIdx);
    for (let i = 0; i < stepIdx; i++) {
      completeStepInstant(i);
    }
    const el = stepElements[stepIdx];
    if (el) {
      el.row.className = 'rv-replay-step-row state-error';
      el.check.className = 'rv-replay-step-check state-error';
      el.barWrap.style.display = 'none';
      el.check.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      `;
    }
    uiSounds.play('generic-error', { volume: 0.8 });
  }

  function handleProgressLog(msg: string): void {
    const lower = msg.toLowerCase();
    if (lower.includes('reading replay') || lower.includes('parsing replay') || lower.includes('fetching score') || lower.includes('reading files') || lower.includes('解析') || lower.includes('读取')) {
      void advanceToStep(0);
    } else if (lower.includes('finding beatmap') || lower.includes('downloading') || lower.includes('fetching .osu') || lower.includes('reading local beatmap') || lower.includes('谱面') || lower.includes('查找')) {
      void advanceToStep(1);
    } else if (lower.includes('loading skin') || lower.includes('皮肤')) {
      void advanceToStep(2);
    } else if (lower.includes('building session') || lower.includes('会话') || lower.includes('渲染') || lower.includes('构建')) {
      void advanceToStep(3);
    } else if (lower.includes('ready') || lower.includes('完成') || lower.includes('就绪') || lower.includes('准备就绪')) {
      void finishAllSteps();
    }
  }

  // Yellow notice block
  const notice = document.createElement('div');
  notice.className = 'rv-replay-notice';
  const noticeText = document.createElement('span');
  noticeText.className = 'rv-replay-notice-text';
  if (isZh()) {
    noticeText.innerHTML = `<strong class="rv-replay-notice-accent">注意：</strong>拖入 <strong class="rv-replay-highlight">.osr 回放文件</strong> 后，系统将自动通过 Hash 匹配并从镜像站下载对应谱面。对于本地制作的未发布谱面，请同时导入 <strong class="rv-replay-highlight">.osz 谱面包</strong>。`;
  } else {
    noticeText.innerHTML = `<strong class="rv-replay-notice-accent">Note:</strong> Dropping a <strong class="rv-replay-highlight">.osr replay</strong> will automatically look up its MD5 hash and download the beatmap set from public mirrors. For unranked or local offline maps, please also provide the <strong class="rv-replay-highlight">.osz package</strong>.`;
  }
  notice.append(noticeText);

  setupBody.append(tabHeader, mainDropCard, oszDropCard, inputGroup, stepsCard, statusMsg, notice);
  setupContent.append(setupHeader, setupBody);

  // 3. Bottom Action Footer Bar (Lazer slanted flat buttons)
  const setupFooter = document.createElement('footer');
  setupFooter.className = 'rv-replay-dialog-footer-bar';

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'rv-replay-footer-actions';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'rv-replay-btn-back-lazer';
  const backSkew = document.createElement('span');
  backSkew.className = 'rv-replay-btn-skew-content';
  const backIcon = icon('chevron-left', { className: 'rv-icon rv-replay-back-chevron' });
  const backLabel = document.createElement('span');
  backLabel.textContent = t('返回', 'Back');
  backSkew.append(backIcon, backLabel);
  backBtn.append(backSkew);
  uiSounds.attachHoverClick(backBtn, { hover: 'button', click: false });
  backBtn.addEventListener('click', () => {
    uiSounds.playClick('dialog-cancel');
    root.hidden = true;
    options.onExit();
  });

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'rv-replay-btn-submit-lazer';
  const playSkew = document.createElement('span');
  playSkew.className = 'rv-replay-btn-skew-content';
  const playLabel = document.createElement('span');
  playLabel.textContent = t('加载并播放！', 'Load and Play!');
  playSkew.append(playLabel);
  playBtn.append(playSkew);
  uiSounds.attachHoverClick(playBtn, { hover: 'button', click: false });

  actionsWrap.append(backBtn, playBtn);
  setupFooter.append(actionsWrap);

  root.append(setupContent, setupFooter, osrInput, oszInput);
  options.host.append(root);

  function handleIncomingFiles(files: File[]): void {
    let hasOsr = false;
    let hasOsz = false;

    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.osr')) {
        pendingOsr = f;
        hasOsr = true;
      } else if (lower.endsWith('.osz') || lower.endsWith('.osu') || lower.endsWith('.zip')) {
        pendingOsz = f;
        hasOsz = true;
      }
    }

    updateFileDisplay();

    if (currentMode === 'auto' && pendingOsz !== null) {
      void executePlay();
    } else if (currentMode === 'replay' && pendingOsr !== null) {
      void executePlay();
    }
  }

  function updateFileDisplay(): void {
    if (currentMode === 'replay') {
      if (pendingOsr !== null) {
        stripTitle.textContent = t('回放文件 (.osr) - 已选择', 'Replay file (.osr) - Selected');
        stripSub.textContent = `✓ ${pendingOsr.name}`;
        stripSub.style.color = '#2feaa8';
        stripSub.style.fontWeight = '700';
      } else {
        stripTitle.textContent = t('回放文件 (.osr)', 'Replay file (.osr)');
        stripSub.textContent = t('点击选择 .osr 回放文件', 'Click to select .osr replay file');
        stripSub.style.color = '';
        stripSub.style.fontWeight = '';
      }

      if (pendingOsz !== null) {
        oszStripTitle.textContent = t('本地谱面文件 (.osz / .osu) - 已选择', 'Local beatmap (.osz / .osu) - Selected');
        oszStripSub.textContent = `✓ ${pendingOsz.name}`;
        oszStripSub.style.color = '#2feaa8';
        oszStripSub.style.fontWeight = '700';
      } else {
        oszStripTitle.textContent = t('本地谱面文件 (.osz / .osu - 可选)', 'Local beatmap file (.osz / .osu - Optional)');
        oszStripSub.textContent = t('若为未上架或本地谱面，可在此导入本地谱面包', 'If offline or unranked, import .osz package here');
        oszStripSub.style.color = '';
        oszStripSub.style.fontWeight = '';
      }
    } else {
      if (pendingOsz !== null) {
        stripTitle.textContent = t('谱面文件 (.osz / .osu) - 已选择', 'Beatmap file (.osz / .osu) - Selected');
        stripSub.textContent = `✓ ${pendingOsz.name}`;
        stripSub.style.color = '#2feaa8';
        stripSub.style.fontWeight = '700';
      } else {
        stripTitle.textContent = t('谱面文件 (.osz / .osu)', 'Beatmap file (.osz / .osu)');
        stripSub.textContent = t('点击选择本地谱面文件', 'Click to select local beatmap file');
        stripSub.style.color = '';
        stripSub.style.fontWeight = '';
      }
    }
  }

  async function executePlay(): Promise<void> {
    const urlVal = urlInput.value.trim();

    // 1. If files are ready
    if (currentMode === 'auto') {
      if (pendingOsz !== null) {
        uiSounds.playClick('dialog-ok');
        startSteps();
        setLoadingStatus(t(`正在载入谱面 "${pendingOsz.name}"…`, `Loading beatmap "${pendingOsz.name}"…`));
        try {
          await options.onLoadAutoOsz(pendingOsz);
          finishAllSteps();
          root.hidden = true;
        } catch (err) {
          markStepError(currentStepIdx);
          setErrorStatus(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    } else {
      if (pendingOsr !== null) {
        uiSounds.playClick('dialog-ok');
        startSteps();
        setLoadingStatus(t(`正在解析回放 "${pendingOsr.name}" 并查找谱面…`, `Parsing replay "${pendingOsr.name}" & resolving beatmap…`));
        try {
          await options.onLoadOsr(pendingOsr, pendingOsz);
          finishAllSteps();
          root.hidden = true;
        } catch (err) {
          markStepError(currentStepIdx);
          setErrorStatus(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    // 2. If online URL / ID is entered
    if (urlVal.length > 0) {
      uiSounds.playClick('dialog-ok');
      startSteps();
      setLoadingStatus(t(`正在获取在线数据 "${urlVal}"…`, `Fetching online data "${urlVal}"…`));
      try {
        await options.onLoadUrl(urlVal);
        finishAllSteps();
        root.hidden = true;
      } catch (err) {
        markStepError(currentStepIdx);
        setErrorStatus(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // 3. No inputs provided
    uiSounds.playError();
    if (currentMode === 'auto') {
      setErrorStatus(t('请拖入 .osz 谱面文件或输入在线链接/ID', 'Please drag a .osz file or enter a beatmap URL/ID'));
    } else {
      setErrorStatus(t('请拖入 .osr 回放文件或输入在线成绩/谱面链接', 'Please drag a .osr replay file or enter a score URL/ID'));
    }
  }

  function setLoadingStatus(msg: string): void {
    statusMsg.textContent = msg;
    statusMsg.className = 'rv-replay-dialog-status rv-status-loading';
    playBtn.disabled = true;
  }

  function setErrorStatus(msg: string): void {
    statusMsg.textContent = msg;
    statusMsg.className = 'rv-replay-dialog-status rv-status-error';
    playBtn.disabled = false;
  }

  function setNormalStatus(msg: string, type: 'info' | 'loading' | 'error' | 'success' = 'info'): void {
    statusMsg.textContent = msg;
    statusMsg.className = `rv-replay-dialog-status rv-status-${type}`;
    playBtn.disabled = type === 'loading';
  }

  playBtn.addEventListener('click', () => {
    void executePlay();
  });

  urlInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void executePlay();
    }
  });

  return {
    root,
    open(mode: 'replay' | 'auto'): void {
      currentMode = mode;
      root.hidden = false;
      playBtn.disabled = false;
      statusMsg.textContent = '';
      statusMsg.className = 'rv-replay-dialog-status';
      resetSteps();

      titleIcon.replaceChildren(icon(mode === 'auto' ? 'mode-auto' : 'mode-single', { className: 'rv-icon' }));

      if (mode === 'auto') {
        headerTitle.textContent = t('自动演示', 'Auto Play');
        headerSub.textContent = t('导入本地未发布谱面或输入在线链接，自动生成满分演示！', 'Import local beatmap or enter online URL to generate auto play!');
        dropPrompt.textContent = t('把 .osz / .osu 谱面拖至此处来生成自动演示！', 'Drag .osz / .osu beatmap here to generate auto play!');
        stripTitle.textContent = t('谱面文件 (.osz / .osu)', 'Beatmap file (.osz / .osu)');
        stripSub.textContent = t('点击选择本地谱面文件', 'Click to select local beatmap file');
        oszDropCard.style.display = 'none';
        urlInput.placeholder = t('输入谱面链接或 ID (如 https://osu.ppy.sh/beatmaps/123456)', 'Enter beatmap URL or ID');
        if (isZh()) {
          noticeText.innerHTML = `<strong class="rv-replay-notice-accent">提示：</strong>可直接拖入任意 <strong class="rv-replay-highlight">.osz 谱面包</strong> 或 <strong class="rv-replay-highlight">.osu 谱面</strong> 进行全模式完美的自动演示。`;
        } else {
          noticeText.innerHTML = `<strong class="rv-replay-notice-accent">Tip:</strong> Drop any <strong class="rv-replay-highlight">.osz archive</strong> or <strong class="rv-replay-highlight">.osu file</strong> to generate perfect auto play in any mode.`;
        }
      } else {
        headerTitle.textContent = t('单人回放', 'Single Replay');
        headerSub.textContent = t('和全世界的玩家一起重温精彩对决！', 'Relive incredible plays from players worldwide!');
        dropPrompt.textContent = t('把 .osr 回放文件拖至此处来自动查找谱面并播放！', 'Drag .osr replay file here to automatically fetch beatmap and play!');
        stripTitle.textContent = t('回放文件 (.osr)', 'Replay file (.osr)');
        stripSub.textContent = t('点击选择 .osr 回放文件', 'Click to select .osr replay file');
        oszDropCard.style.display = 'flex';
        urlInput.placeholder = t('输入链接 (如 https://osu.ppy.sh/scores/123456 或 123456)', 'Enter score URL (e.g. https://osu.ppy.sh/scores/123456 or 123456)');
        if (isZh()) {
          noticeText.innerHTML = `<strong class="rv-replay-notice-accent">注意：</strong>拖入 <strong class="rv-replay-highlight">.osr 回放文件</strong> 后，系统将自动通过 Hash 匹配并从镜像站下载对应谱面。对于本地制作的未发布谱面，请同时导入 <strong class="rv-replay-highlight">.osz 谱面包</strong>。`;
        } else {
          noticeText.innerHTML = `<strong class="rv-replay-notice-accent">Note:</strong> Dropping a <strong class="rv-replay-highlight">.osr replay</strong> will automatically look up its MD5 hash and download the beatmap set from public mirrors. For unranked or local offline maps, please also provide the <strong class="rv-replay-highlight">.osz package</strong>.`;
        }
      }

      updateFileDisplay();
    },
    close(): void {
      root.hidden = true;
    },
    setStatus(msg: string, type: 'info' | 'loading' | 'error' | 'success' = 'info'): void {
      setNormalStatus(msg, type);
    },
    setPendingFiles(osr: File | null, osz: File | null): void {
      pendingOsr = osr;
      pendingOsz = osz;
      updateFileDisplay();
    },
    handleProgress(msg: string): void {
      handleProgressLog(msg);
    },
    async finishProgress(): Promise<void> {
      await finishAllSteps();
    },
    resetProgress(): void {
      resetSteps();
    },
    destroy(): void {
      root.hidden = true;
      pendingOsr = null;
      pendingOsz = null;
      urlInput.value = '';
      statusMsg.textContent = '';
      resetSteps();
    },
  };
}

function singleReplayCss(): string {
  return `
/* In-page Single Replay & Auto Setup Screen */
.rv-replay-setup-screen {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: stretch;
  background: radial-gradient(circle at 50% 28%, #1c2b26 0%, #0d1412 100%);
  overflow: hidden;
  user-select: none;
  animation: rvReplayBackdropFadeIn 240ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.rv-replay-setup-screen[hidden] {
  display: none !important;
}

.rv-replay-setup-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 0 24px 20px;
  overflow-y: auto;
  box-sizing: border-box;
}

/* Top Hanging Header Banner Card ("单人回放" / "自动演示") */
.rv-replay-dialog-header {
  width: 860px;
  max-width: 90vw;
  background: #354b43;
  border: none;
  border-bottom: 4px solid #23332d;
  border-radius: 0 0 10px 10px;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
  animation: rvReplayHeaderSlideDown 280ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  box-sizing: border-box;
  flex-shrink: 0;
  margin-bottom: 16px;
}
.rv-replay-dialog-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.rv-replay-title-icon {
  font-size: 24px;
  color: #4ed9c8;
  flex-shrink: 0;
}
.rv-replay-dialog-header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.rv-replay-dialog-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: -0.01em;
}
.rv-replay-dialog-subtitle {
  margin: 0;
  font-size: 12px;
  color: #9dc2b3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rv-replay-dialog-close-btn {
  width: 32px;
  height: 32px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 120ms ease;
  flex-shrink: 0;
}
.rv-replay-dialog-close-btn:hover {
  background: rgba(235, 70, 116, 0.3);
  border-color: rgba(235, 70, 116, 0.5);
  color: #ffffff;
  transform: scale(1.06);
}
.rv-replay-dialog-close-btn:active {
  transform: scale(0.94);
}

/* Center Setup Content Card ("资源") */
.rv-replay-dialog-body {
  width: 860px;
  max-width: 90vw;
  background: #16201d;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  padding: 28px 36px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 16px;
  animation: rvReplayBodyPopIn 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  box-sizing: border-box;
  min-height: 460px;
  flex: 1;
}

/* Section Tab Bar */
.rv-replay-section-tab-bar {
  display: flex;
  align-items: center;
  gap: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 4px;
  margin-bottom: 4px;
}
.rv-replay-section-tab {
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.rv-replay-tab-text {
  font-size: 15px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: -0.01em;
}
.rv-replay-tab-line {
  height: 3px;
  background: #2feaa8;
  border-radius: 2px;
  box-shadow: 0 0 8px rgba(47, 234, 168, 0.6);
}

/* Big Drag & Drop Hero Card */
.rv-replay-drop-card {
  background: #101715;
  border: 2px solid #233932;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  transition: all 180ms ease;
  overflow: hidden;
}
.rv-replay-drop-card:hover {
  border-color: #2feaa8;
  box-shadow: 0 0 14px rgba(47, 234, 168, 0.2);
}
.rv-replay-drop-card.dragover {
  border-color: #46f8b6;
  background: #14241f;
  box-shadow: 0 0 24px rgba(70, 248, 182, 0.35);
  transform: scale(1.01);
}

.rv-replay-drop-hero {
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: #111a17;
  border-bottom: 1.5px solid rgba(255, 255, 255, 0.06);
}
.rv-replay-drop-icon-wrap {
  color: #a4c2ba;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 180ms ease, color 180ms ease;
}
.rv-replay-drop-card:hover .rv-replay-drop-icon-wrap {
  color: #2feaa8;
  transform: translateY(-2px);
}
.rv-replay-drop-prompt {
  font-size: 16px;
  font-weight: 700;
  color: #ffffff;
  text-align: center;
  letter-spacing: -0.01em;
}

.rv-replay-drop-strip {
  padding: 12px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #162420;
  transition: background 150ms ease;
}
.rv-replay-drop-card:hover .rv-replay-drop-strip {
  background: #1b2e29;
}
.rv-replay-strip-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.rv-replay-strip-title {
  font-size: 12px;
  font-weight: 600;
  color: #92b0a6;
}
.rv-replay-strip-sub {
  font-size: 13px;
  font-weight: 500;
  color: #ffffff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rv-replay-folder-btn {
  width: 34px;
  height: 34px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 120ms ease;
  flex-shrink: 0;
}
.rv-replay-folder-btn:hover {
  background: rgba(47, 234, 168, 0.25);
  border-color: #2feaa8;
  color: #2feaa8;
}

/* Secondary Compact .osz Strip */
.rv-replay-drop-card-sub {
  background: #111a17;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  transition: all 150ms ease;
}
.rv-replay-drop-card-sub:hover {
  border-color: #2feaa8;
  background: #15241f;
}

/* Input Group */
.rv-replay-input-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.rv-replay-input-label {
  font-size: 12px;
  font-weight: 600;
  color: #90a8a0;
  user-select: none;
}
.rv-replay-input-wrap {
  background: #0e1614;
  border: 1.5px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
}
.rv-replay-input-wrap:focus-within {
  border-color: #2feaa8;
  box-shadow: 0 0 0 3px rgba(47, 234, 168, 0.2), 0 0 16px rgba(47, 234, 168, 0.15);
  background: #111b18;
}
.rv-replay-input-icon {
  color: rgba(255, 255, 255, 0.45);
  font-size: 16px;
  flex-shrink: 0;
  transition: color 150ms ease;
}
.rv-replay-input-wrap:focus-within .rv-replay-input-icon {
  color: #2feaa8;
}
.rv-replay-input-field {
  flex: 1;
  background: transparent;
  border: none;
  color: #ffffff;
  font-size: 13.5px;
  font-family: inherit;
  outline: none;
  min-width: 0;
}
.rv-replay-input-field::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

/* Multi-step loading checklist card (Matching Image 2) */
.rv-replay-steps-card {
  background: #111a17;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  animation: rvReplayFadeIn 200ms ease forwards;
}
.rv-replay-steps-card[hidden] {
  display: none !important;
}

.rv-replay-step-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-size: 13.5px;
  font-weight: 600;
  color: #a4c2ba;
  transition: color 150ms ease;
}
.rv-replay-step-row.state-active {
  color: #ffffff;
  font-weight: 700;
}
.rv-replay-step-row.state-done {
  color: #e0ecea;
}
.rv-replay-step-row.state-pending {
  color: #4a635b;
}
.rv-replay-step-row.state-error {
  color: #ff6677;
}

.rv-replay-step-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.rv-replay-step-progress-bar {
  width: 120px;
  height: 8px;
  background: #182823;
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.rv-replay-step-progress-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 0%;
  background: linear-gradient(90deg, #2feaa8, #5cffcc);
  border-radius: 4px;
  box-shadow: 0 0 8px rgba(47, 234, 168, 0.4);
}

.rv-replay-step-check {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 180ms ease;
}
.rv-replay-step-check.state-done {
  background: #2feaa8;
  color: #062217;
  box-shadow: 0 0 8px rgba(47, 234, 168, 0.4);
  animation: rvStepCheckPop 220ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.rv-replay-step-check.state-active {
  border: 2px solid #2feaa8;
  color: #2feaa8;
  background: transparent;
  animation: rvReplayCheckPulse 1.2s infinite ease-in-out;
}

@keyframes rvStepCheckPop {
  0% { transform: scale(0.6); opacity: 0; }
  70% { transform: scale(1.22); }
  100% { transform: scale(1); opacity: 1; }
}
.rv-replay-step-check.state-pending {
  border: 1.5px solid #3b5048;
  color: #3b5048;
  background: transparent;
}
.rv-replay-step-check.state-error {
  background: #ff4455;
  color: #ffffff;
  box-shadow: 0 0 8px rgba(255, 68, 85, 0.4);
}

@keyframes rvReplayCheckPulse {
  0%, 100% { transform: scale(1); opacity: 0.8; }
  50% { transform: scale(1.1); opacity: 1; }
}

.rv-replay-dialog-status {
  font-size: 12.5px;
  min-height: 18px;
  line-height: 1.4;
  transition: all 150ms ease;
}
.rv-replay-dialog-status.rv-status-error {
  color: #ff5566;
  font-weight: 600;
}
.rv-replay-dialog-status.rv-status-loading {
  color: #4ed9c8;
  font-weight: 600;
}
.rv-replay-dialog-status.rv-status-success {
  color: #2feaa8;
  font-weight: 600;
}

.rv-replay-notice {
  margin-top: auto;
  font-size: 12.5px;
  line-height: 1.6;
  color: #ffcc22;
  user-select: none;
}
.rv-replay-notice-accent {
  color: #ffcc22;
  font-weight: 700;
}
.rv-replay-highlight {
  color: #ffcc22;
  font-weight: 700;
}

/* Bottom Action Footer Bar (Lazer Edge-to-Edge Parallelogram Buttons with Solid Flat Color) */
.rv-replay-dialog-footer-bar {
  flex: 0 0 54px;
  height: 54px;
  background: #111816;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  position: relative;
  z-index: 30;
  user-select: none;
  box-sizing: border-box;
  animation: rvReplayFooterSlideUp 280ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.rv-replay-footer-actions {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 100%;
}
.rv-replay-btn-back-lazer {
  background: #db2878;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-bottom: 2px solid rgba(255, 255, 255, 0.35);
  border-right: 1.5px solid rgba(255, 255, 255, 0.25);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35);
  height: 42px;
  width: 170px;
  font-size: 14px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: skewX(-12deg);
  border-radius: 8px;
  transition: background 120ms ease, transform 120ms ease;
  flex-shrink: 0;
}
.rv-replay-btn-back-lazer:hover {
  background: #e63889;
  transform: skewX(-12deg) translateY(-1px);
}
.rv-replay-btn-back-lazer:active {
  background: #c71e6c;
  transform: skewX(-12deg) translateY(0);
}

.rv-replay-btn-submit-lazer {
  flex: 1;
  background: #2feaa8;
  color: #082218;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-bottom: 2px solid rgba(255, 255, 255, 0.45);
  border-right: 1.5px solid rgba(255, 255, 255, 0.3);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35);
  height: 42px;
  font-size: 15px;
  font-weight: 800;
  font-family: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: skewX(-12deg);
  border-radius: 8px;
  transition: background 120ms ease, transform 120ms ease;
}
.rv-replay-btn-submit-lazer:hover:not(:disabled) {
  background: #46f8b6;
  transform: skewX(-12deg) translateY(-1px);
}
.rv-replay-btn-submit-lazer:active:not(:disabled) {
  background: #24d393;
  transform: skewX(-12deg) translateY(0);
}
.rv-replay-btn-submit-lazer:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rv-replay-btn-skew-content {
  transform: skewX(12deg);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.rv-replay-back-chevron {
  font-size: 18px;
}

/* Animations */
@keyframes rvReplayBackdropFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes rvReplayHeaderSlideDown {
  from { transform: translateY(-30px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
@keyframes rvReplayBodyPopIn {
  from { transform: scale(0.97) translateY(10px); opacity: 0; }
  to { transform: scale(1) translateY(0); opacity: 1; }
}
@keyframes rvReplayFooterSlideUp {
  from { transform: translateY(30px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
  `;
}
