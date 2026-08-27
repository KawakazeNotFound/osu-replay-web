/**
 * osu!lazer-authentic PlayerLoader transition screen.
 *
 * Implements the complete pre-gameplay loading sequence matching osu!lazer's PlayerLoader:
 * 1. Stage 1 (Entry / Figure 2): Blurred background, central pulsating osu! logo, metadata fade-in and slide-up.
 * 2. Stage 2 (Figure 3): Star rating badge pop-in animation under difficulty name.
 * 3. Stage 3 (Figures 4 & 5): Left-side strobe/epilepsy warning and right-side Quick Settings drawer slide-in.
 * 4. Stage 4 (Hold / Ready): Enforces a minimum presentation duration (~2000ms), pauses if user is interacting with settings.
 * 5. Stage 5 (Exit to Gameplay): Metadata expands & fades out, settings slide out, background blur clears, and playback seamlessly begins.
 */

import type { CoreSession } from '../../src/index.js';
import type { ResultsPanelData } from '../results/panel.js';
import { uiSounds } from './uiSounds.js';

export interface PlayerLoaderOptions {
  readonly host: HTMLElement;
  readonly session: CoreSession;
  readonly panel: ResultsPanelData;
  readonly onReady: () => void;
  readonly onCancel: () => void;
}

export interface PlayerLoaderHandle {
  readonly root: HTMLElement;
  start(): void;
  cancel(): void;
  destroy(): void;
}

export function playerLoaderCss(): string {
  return `
.rv-player-loader {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #000;
  font-family: "Torus", "Quicksand", system-ui, sans-serif;
  color: #fff;
  user-select: none;
  z-index: 100;
}

/* Background Layer */
.pl-bg-layer {
  position: absolute;
  inset: -30px; /* Slight overflow to hide blur edge artifacts */
  overflow: hidden;
  pointer-events: none;
}
.pl-bg-canvas {
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(20px);
  transform: scale(1.08);
  transition: filter 500ms cubic-bezier(0.22, 1, 0.36, 1), opacity 500ms ease;
}
.pl-bg-dim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  transition: background 500ms ease;
}

/* Central Content */
.pl-content {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: auto;
  z-index: 10;
  transition: opacity 280ms cubic-bezier(0.64, 0, 0.78, 0), transform 280ms cubic-bezier(0.64, 0, 0.78, 0);
}

/* osu! Logo */
.pl-logo-wrapper {
  margin-bottom: 12px;
}
.pl-logo {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: #eb4674;
  border: 3.5px solid rgba(255, 255, 255, 0.95);
  box-shadow: 0 4px 26px rgba(235, 70, 116, 0.55), inset 0 0 12px rgba(255, 255, 255, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: plLogoBeat 800ms ease-in-out infinite;
}
.pl-logo-text {
  font-size: 30px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: -0.5px;
  transform: rotate(-6deg);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

@keyframes plLogoBeat {
  0% { transform: scale(1); }
  35% { transform: scale(1.05); }
  70% { transform: scale(0.99); }
  100% { transform: scale(1); }
}

/* Metadata Display */
.pl-metadata {
  display: flex;
  flex-direction: column;
  align-items: center;
  opacity: 0;
  transform: translateY(18px);
  transition: opacity 500ms cubic-bezier(0.22, 1, 0.36, 1), transform 500ms cubic-bezier(0.22, 1, 0.36, 1);
}
.pl-metadata.pl-show {
  opacity: 1;
  transform: translateY(0);
}

.pl-meta-title {
  font-size: 26px;
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.75);
  text-align: center;
  max-width: 600px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-meta-artist {
  font-size: 15px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.8);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.65);
  margin-top: 3px;
  text-align: center;
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-meta-banner {
  width: 360px;
  height: 96px;
  border-radius: 10px;
  overflow: hidden;
  margin: 12px 0 10px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: #181822;
  position: relative;
}
.pl-banner-canvas {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pl-meta-difficulty {
  font-size: 19px;
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
  text-align: center;
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-meta-badge-row {
  margin-top: 6px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pl-star-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #eb4674;
  color: #ffffff;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 700;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  opacity: 0;
  transform: scale(0.7);
  transition: opacity 350ms cubic-bezier(0.34, 1.56, 0.64, 1), transform 350ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.pl-star-badge.pl-show {
  opacity: 1;
  transform: scale(1);
}
.pl-star-icon {
  font-size: 11px;
}

.pl-meta-info-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin-top: 10px;
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.6);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
}

/* Left Side Disclaimer / Warning */
.pl-disclaimer {
  position: absolute;
  left: 28px;
  top: 32px;
  display: flex;
  align-items: stretch;
  gap: 10px;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  max-width: 320px;
  opacity: 0;
  transform: translateX(-30px);
  transition: opacity 450ms cubic-bezier(0.22, 1, 0.36, 1), transform 450ms cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 10;
}
.pl-disclaimer.pl-show {
  opacity: 1;
  transform: translateX(0);
}
.pl-disclaimer-bar {
  width: 4px;
  border-radius: 2px;
  background: #ffcc22;
  flex-shrink: 0;
}
.pl-disclaimer-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pl-disclaimer-title {
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  line-height: 1.4;
}
.pl-disclaimer-desc {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.35;
}

/* Right Side Quick Settings Drawer */
.pl-settings-drawer {
  position: absolute;
  right: 28px;
  top: 24px;
  bottom: 24px;
  width: 290px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  opacity: 0;
  transform: translateX(40px);
  transition: opacity 500ms cubic-bezier(0.22, 1, 0.36, 1), transform 500ms cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 15;
}
.pl-settings-drawer::-webkit-scrollbar {
  width: 4px;
}
.pl-settings-drawer::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}
.pl-settings-drawer.pl-show {
  opacity: 1;
  transform: translateX(0);
}

.pl-settings-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pl-group-title {
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  letter-spacing: 0.2px;
}

.pl-control-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.pl-control-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.88);
}
.pl-control-label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pl-control-val {
  font-size: 11.5px;
  color: #ffcc22;
  font-weight: 600;
}

/* Slider */
.pl-slider-track {
  position: relative;
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.16);
  cursor: pointer;
}
.pl-slider-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: #ffcc22;
  border-radius: 3px;
  pointer-events: none;
}
.pl-slider-thumb {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: transform 80ms ease;
}
.pl-slider-track:hover .pl-slider-thumb {
  transform: translate(-50%, -50%) scale(1.2);
}

/* Toggle Switch */
.pl-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 2px 0;
}
.pl-toggle-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.88);
}
.pl-toggle-switch {
  width: 36px;
  height: 18px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.2);
  position: relative;
  transition: background 150ms ease;
}
.pl-toggle-switch.pl-checked {
  background: #ffcc22;
}
.pl-toggle-handle {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1);
}
.pl-toggle-switch.pl-checked .pl-toggle-handle {
  transform: translateX(18px);
}

/* Bottom Left Back Button */
.pl-back-btn {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 42px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #eb4674;
  color: #ffffff;
  border: none;
  padding: 0 18px 0 12px;
  cursor: pointer;
  z-index: 30;
  border-top-right-radius: 6px;
  transition: background 120ms ease, transform 120ms ease;
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 700;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.pl-back-btn:hover {
  background: #f06292;
  transform: translateX(2px);
}
.pl-back-icon-circle {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #ffffff;
  color: #eb4674;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 900;
}
`;
}

/** Draws an ImageBitmap into a canvas covering the entire box (object-fit: cover). */
function drawCoverToCanvas(canvas: HTMLCanvasElement, bitmap: ImageBitmap | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!bitmap) {
    ctx.fillStyle = '#1e1e28';
    ctx.fillRect(0, 0, w, h);
    return;
  }

  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const scale = Math.max(w / srcW, h / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const offsetX = (w - drawW) / 2;
  const offsetY = (h - drawH) / 2;

  ctx.drawImage(bitmap, offsetX, offsetY, drawW, drawH);
}

export function buildPlayerLoader(options: PlayerLoaderOptions): PlayerLoaderHandle {
  const { host, session, panel, onReady, onCancel } = options;

  const root = document.createElement('div');
  root.className = 'rv-player-loader';

  // 1. Background layer
  const bgLayer = document.createElement('div');
  bgLayer.className = 'pl-bg-layer';

  const bgCanvas = document.createElement('canvas');
  bgCanvas.className = 'pl-bg-canvas';
  bgCanvas.width = 640;
  bgCanvas.height = 360;
  drawCoverToCanvas(bgCanvas, session.background);

  const bgDim = document.createElement('div');
  bgDim.className = 'pl-bg-dim';
  bgLayer.append(bgCanvas, bgDim);

  // 2. Central Content (Logo & Metadata)
  const content = document.createElement('div');
  content.className = 'pl-content';

  const logoWrapper = document.createElement('div');
  logoWrapper.className = 'pl-logo-wrapper';
  const logo = document.createElement('div');
  logo.className = 'pl-logo';
  const logoText = document.createElement('span');
  logoText.className = 'pl-logo-text';
  logoText.textContent = 'osu!';
  logo.append(logoText);
  logoWrapper.append(logo);

  const metadata = document.createElement('div');
  metadata.className = 'pl-metadata';

  const metaTitle = document.createElement('div');
  metaTitle.className = 'pl-meta-title';
  metaTitle.textContent = panel.title || '(unknown title)';

  const metaArtist = document.createElement('div');
  metaArtist.className = 'pl-meta-artist';
  metaArtist.textContent = panel.artist || '(unknown artist)';

  const metaBanner = document.createElement('div');
  metaBanner.className = 'pl-meta-banner';
  const bannerCanvas = document.createElement('canvas');
  bannerCanvas.className = 'pl-banner-canvas';
  bannerCanvas.width = 380;
  bannerCanvas.height = 100;
  drawCoverToCanvas(bannerCanvas, session.background);
  metaBanner.append(bannerCanvas);

  const metaDiff = document.createElement('div');
  metaDiff.className = 'pl-meta-difficulty';
  metaDiff.textContent = panel.difficulty || 'Normal';

  const metaBadgeRow = document.createElement('div');
  metaBadgeRow.className = 'pl-meta-badge-row';
  const starBadge = document.createElement('div');
  starBadge.className = 'pl-star-badge';
  const starIcon = document.createElement('span');
  starIcon.className = 'pl-star-icon';
  starIcon.textContent = '★';
  const starVal = document.createElement('span');
  starVal.textContent = (panel.starRating !== null && panel.starRating !== undefined)
    ? panel.starRating.toFixed(2)
    : '4.44';
  starBadge.append(starIcon, starVal);
  metaBadgeRow.append(starBadge);

  const metaInfoRow = document.createElement('div');
  metaInfoRow.className = 'pl-meta-info-row';
  const sourceText = document.createElement('div');
  sourceText.textContent = `来源 ${panel.source ? panel.source : '-'}`;
  const mapperText = document.createElement('div');
  mapperText.textContent = `谱面作者 ${panel.mapper || panel.playerName || '-'}`;
  metaInfoRow.append(sourceText, mapperText);

  metadata.append(metaTitle, metaArtist, metaBanner, metaDiff, metaBadgeRow, metaInfoRow);
  content.append(logoWrapper, metadata);

  // 3. Left Side Disclaimer
  const disclaimer = document.createElement('div');
  disclaimer.className = 'pl-disclaimer';
  const disclaimerBar = document.createElement('div');
  disclaimerBar.className = 'pl-disclaimer-bar';
  const disclaimerContent = document.createElement('div');
  disclaimerContent.className = 'pl-disclaimer-content';
  const discTitle = document.createElement('div');
  discTitle.className = 'pl-disclaimer-title';
  discTitle.textContent = '这张谱面包含颜色快速切换闪烁的场景';
  const discDesc = document.createElement('div');
  discDesc.className = 'pl-disclaimer-desc';
  discDesc.textContent = '如果你患有光敏性癫痫症，请务必注意。';
  disclaimerContent.append(discTitle, discDesc);
  disclaimer.append(disclaimerBar, disclaimerContent);

  // 4. Right Side Quick Settings Drawer
  const drawer = document.createElement('div');
  drawer.className = 'pl-settings-drawer';

  let userInteracting = false;
  drawer.addEventListener('pointerenter', () => { userInteracting = true; });
  drawer.addEventListener('pointerleave', () => { userInteracting = false; checkAndTriggerReady(); });

  // Helper for sliders
  function buildSliderRow(
    label: string,
    min: number,
    max: number,
    step: number,
    initialVal: number,
    format: (v: number) => string,
    onChange: (v: number) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pl-control-row';

    const header = document.createElement('div');
    header.className = 'pl-control-header';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'pl-control-label';
    labelSpan.textContent = label;
    const valSpan = document.createElement('span');
    valSpan.className = 'pl-control-val';
    valSpan.textContent = format(initialVal);
    header.append(labelSpan, valSpan);

    const track = document.createElement('div');
    track.className = 'pl-slider-track';
    const fill = document.createElement('div');
    fill.className = 'pl-slider-fill';
    const thumb = document.createElement('div');
    thumb.className = 'pl-slider-thumb';

    const updateDisplay = (v: number) => {
      const pct = Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
      fill.style.width = `${pct}%`;
      thumb.style.left = `${pct}%`;
      valSpan.textContent = format(v);
    };
    updateDisplay(initialVal);

    let isDragging = false;
    const setFromEvent = (e: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      let rawVal = min + frac * (max - min);
      if (step > 0) {
        rawVal = Math.round(rawVal / step) * step;
      }
      const clamped = Math.max(min, Math.min(max, rawVal));
      updateDisplay(clamped);
      onChange(clamped);
    };

    track.addEventListener('pointerdown', e => {
      e.stopPropagation();
      userInteracting = true;
      isDragging = true;
      track.setPointerCapture(e.pointerId);
      setFromEvent(e);
    });
    track.addEventListener('pointermove', e => {
      if (isDragging) {
        setFromEvent(e);
      }
    });
    track.addEventListener('pointerup', e => {
      if (isDragging) {
        isDragging = false;
        try { track.releasePointerCapture(e.pointerId); } catch {}
        userInteracting = false;
        checkAndTriggerReady();
      }
    });

    track.append(fill, thumb);
    row.append(header, track);
    return row;
  }

  // Helper for toggle switches
  function buildToggleRow(
    label: string,
    initialVal: boolean,
    onChange: (v: boolean) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pl-toggle-row';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'pl-toggle-label';
    labelSpan.textContent = label;

    const switchEl = document.createElement('div');
    switchEl.className = `pl-toggle-switch ${initialVal ? 'pl-checked' : ''}`;
    const handle = document.createElement('div');
    handle.className = 'pl-toggle-handle';
    switchEl.append(handle);

    let currentVal = initialVal;
    row.addEventListener('click', () => {
      currentVal = !currentVal;
      switchEl.classList.toggle('pl-checked', currentVal);
      uiSounds.playToggle(currentVal);
      onChange(currentVal);
    });

    row.append(labelSpan, switchEl);
    return row;
  }

  // Group 1: 显示设置 (Display Settings)
  const displayGroup = document.createElement('div');
  displayGroup.className = 'pl-settings-group';
  const displayTitle = document.createElement('div');
  displayTitle.className = 'pl-group-title';
  displayTitle.textContent = '显示设置';

  let currentBlur = 0;
  displayGroup.append(
    displayTitle,
    buildSliderRow('背景暗化', 0, 1, 0.01, session.renderer.options.backgroundDim, v => `${Math.round(v * 100)}%`, v => {
      session.renderer.options.backgroundDim = v;
    }),
    buildSliderRow('背景模糊', 0, 1, 0.01, currentBlur, v => `${Math.round(v * 100)}%`, v => {
      currentBlur = v;
    }),
    buildToggleRow('故事板 / 视频', session.renderer.options.showStoryboard, v => {
      session.renderer.options.showStoryboard = v;
    }),
    buildToggleRow('谱面皮肤', true, () => {}),
    buildToggleRow('谱面连击颜色', true, () => {}),
    buildSliderRow('连击颜色标准化程度', 0, 1, 0.01, 1, v => `${Math.round(v * 100)}%`, () => {}),
  );

  // Group 2: 音频设置 (Audio Settings)
  const audioGroup = document.createElement('div');
  audioGroup.className = 'pl-settings-group';
  const audioTitle = document.createElement('div');
  audioTitle.className = 'pl-group-title';
  audioTitle.textContent = '音频设置';

  audioGroup.append(
    audioTitle,
    buildToggleRow('谱面打击音效', true, v => {
      session.audioSync.setBeatmapHitsounds(v);
    }),
    buildSliderRow('音频偏移（此谱面）', -200, 200, 1, session.renderer.options.audioOffsetMs, v => `${v > 0 ? '+' : ''}${v} ms`, v => {
      session.renderer.options.audioOffsetMs = v;
    }),
  );

  // Group 3: 输入设置 (Input Settings)
  const inputGroup = document.createElement('div');
  inputGroup.className = 'pl-settings-group';
  const inputTitle = document.createElement('div');
  inputTitle.className = 'pl-group-title';
  inputTitle.textContent = '输入设置';

  inputGroup.append(
    inputTitle,
    buildToggleRow('在游戏中禁用鼠标点击', true, () => {}),
  );

  drawer.append(displayGroup, audioGroup, inputGroup);

  // 5. Bottom Left Back Button
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'pl-back-btn';
  const backIcon = document.createElement('div');
  backIcon.className = 'pl-back-icon-circle';
  backIcon.textContent = '❮';
  const backLabel = document.createElement('span');
  backLabel.textContent = '返回';
  backBtn.append(backIcon, backLabel);
  uiSounds.attachHoverClick(backBtn, { hover: 'button', click: false });

  root.append(bgLayer, content, disclaimer, drawer, backBtn);
  host.append(root);

  // Timers & State Machine
  const timers: number[] = [];
  let isCancelled = false;
  let isExiting = false;
  let readyScheduled = false;

  function cancelAllTimers(): void {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  }

  function handleCancel(): void {
    if (isCancelled || isExiting) return;
    isCancelled = true;
    cancelAllTimers();
    uiSounds.playClick('dialog-cancel');
    root.style.transition = 'opacity 200ms ease';
    root.style.opacity = '0';
    setTimeout(() => {
      destroy();
      onCancel();
    }, 200);
  }
  backBtn.addEventListener('click', handleCancel);

  function checkAndTriggerReady(): void {
    if (isCancelled || isExiting || readyScheduled || userInteracting) return;
    readyScheduled = true;
    timers.push(window.setTimeout(() => {
      if (isCancelled || isExiting) return;
      if (userInteracting) {
        readyScheduled = false;
        return;
      }
      transitionToGameplay();
    }, 400));
  }

  function transitionToGameplay(): void {
    if (isCancelled || isExiting) return;
    isExiting = true;
    cancelAllTimers();

    // Stage 5: Exit to Gameplay
    // Metadata & logo expand and fade out
    content.style.transition = 'opacity 250ms cubic-bezier(0.64, 0, 0.78, 0), transform 250ms cubic-bezier(0.64, 0, 0.78, 0)';
    content.style.opacity = '0';
    content.style.transform = 'translate(-50%, -50%) scale(1.06)';

    // Disclaimer & settings slide away
    disclaimer.style.transition = 'opacity 200ms ease, transform 200ms ease';
    disclaimer.style.opacity = '0';
    disclaimer.style.transform = 'translateX(-20px)';

    drawer.style.transition = 'opacity 200ms ease, transform 200ms ease';
    drawer.style.opacity = '0';
    drawer.style.transform = 'translateX(30px)';

    backBtn.style.transition = 'opacity 150ms ease';
    backBtn.style.opacity = '0';

    // Clear background blur & transition dim
    bgCanvas.style.filter = currentBlur > 0 ? `blur(${Math.round(currentBlur * 20)}px)` : 'blur(0px)';
    bgDim.style.background = `rgba(0, 0, 0, ${session.renderer.options.backgroundDim})`;

    timers.push(window.setTimeout(() => {
      if (isCancelled) return;
      root.style.transition = 'opacity 150ms ease';
      root.style.opacity = '0';
      timers.push(window.setTimeout(() => {
        destroy();
        onReady();
      }, 150));
    }, 300));
  }

  function start(): void {
    // Stage 1 (Entry / Figure 2): Metadata fades in & glides up
    timers.push(window.setTimeout(() => {
      if (isCancelled || isExiting) return;
      metadata.classList.add('pl-show');
    }, 80));

    // Stage 2 (Figure 3): Star Rating badge pops in
    timers.push(window.setTimeout(() => {
      if (isCancelled || isExiting) return;
      starBadge.classList.add('pl-show');
    }, 320));

    // Stage 3 (Figures 4 & 5): Disclaimer and settings drawer slide in
    timers.push(window.setTimeout(() => {
      if (isCancelled || isExiting) return;
      disclaimer.classList.add('pl-show');
      drawer.classList.add('pl-show');
    }, 550));

    // Stage 4: Hold Duration (1900ms) before transitioning to gameplay
    timers.push(window.setTimeout(() => {
      checkAndTriggerReady();
    }, 1900));
  }

  function destroy(): void {
    cancelAllTimers();
    root.remove();
  }

  return {
    root,
    start,
    cancel: handleCancel,
    destroy,
  };
}
