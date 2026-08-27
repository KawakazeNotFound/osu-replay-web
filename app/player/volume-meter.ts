/**
 * Floating circular HUD for volume and seek adjustments (osu!lazer style).
 *
 * Displays stacked glowing circular meters for Effects and Music volumes,
 * and a seek meter when seeking. Supports independent wheel adjustments
 * when hovering over individual discs.
 */

import { uiSounds } from './uiSounds.js';

const ACCENT = '#ffcc22';
const ARC_LENGTH = 216.77;
const CIRCUMFERENCE = 289.026;

/**
 * Calculates non-linear acceleration for repeated key presses.
 * Fast consecutive taps increase step size non-linearly.
 */
export class KeyAccelerator {
  private lastPressTime = 0;
  private streak = 0;

  constructor(
    private readonly baseDelta: number,
    private readonly maxMultiplier = 8,
    private readonly resetWindowMs = 320,
  ) {}

  getDelta(now: number = performance.now()): number {
    const dt = now - this.lastPressTime;
    this.lastPressTime = now;
    if (dt < this.resetWindowMs && dt > 0) {
      this.streak = Math.min(this.streak + 1, 12);
    } else {
      this.streak = 0;
    }
    // Non-linear acceleration: 1 + (streak / 3)^1.5
    const multiplier = Math.min(this.maxMultiplier, 1 + Math.pow(this.streak / 3, 1.5));
    return this.baseDelta * multiplier;
  }

  reset(): void {
    this.streak = 0;
    this.lastPressTime = 0;
  }
}

export interface VolumeMeterCallbacks {
  readonly onAdjustMusic?: (delta: number) => void;
  readonly onAdjustEffects?: (delta: number) => void;
}

export interface VolumeMeterHandle {
  readonly root: HTMLElement;
  showVolumes(musicFraction: number, effectsFraction: number): void;
  showMusicVolume(musicFraction: number): void;
  showEffectsVolume(effectsFraction: number): void;
  showSeek(targetMs: number, deltaMs: number, totalDurationMs: number): void;
  destroy(): void;
}

const speakerSvg = (muted: boolean): string => {
  if (muted) {
    return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
      <path d="M4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
  </svg>`;
};

const seekSvg = (forward: boolean): string => {
  if (forward) {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
      <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
    <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/>
  </svg>`;
};

const formatMinSec = (ms: number): string => {
  const secTotal = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secTotal / 60);
  const s = secTotal % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

interface DiscUnit {
  readonly root: HTMLElement;
  setFraction(fraction: number): void;
  setActive(active: boolean): void;
}

function createDiscUnit(label: string, onWheel?: (delta: number) => void): DiscUnit {
  const row = document.createElement('div');
  row.className = 'ps-hud-row';

  const disc = document.createElement('div');
  disc.className = 'ps-hud-disc';

  // SVG circular arc gauge
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'ps-hud-svg');

  const arcBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  arcBg.setAttribute('cx', '50');
  arcBg.setAttribute('cy', '50');
  arcBg.setAttribute('r', '42');
  arcBg.setAttribute('fill', 'none');
  arcBg.setAttribute('class', 'ps-hud-arc-bg');
  arcBg.setAttribute('stroke-dasharray', `${ARC_LENGTH} ${CIRCUMFERENCE}`);
  arcBg.setAttribute('transform', 'rotate(135 50 50)');

  const arcFill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  arcFill.setAttribute('cx', '50');
  arcFill.setAttribute('cy', '50');
  arcFill.setAttribute('r', '42');
  arcFill.setAttribute('fill', 'none');
  arcFill.setAttribute('class', 'ps-hud-arc-fill');
  arcFill.setAttribute('stroke-dasharray', `${ARC_LENGTH} ${CIRCUMFERENCE}`);
  arcFill.setAttribute('stroke-dashoffset', String(ARC_LENGTH));
  arcFill.setAttribute('transform', 'rotate(135 50 50)');

  svg.append(arcBg, arcFill);

  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'ps-hud-value';
  valueDisplay.textContent = '25';

  const subIcon = document.createElement('div');
  subIcon.className = 'ps-hud-icon';
  subIcon.innerHTML = speakerSvg(false);

  disc.append(svg, valueDisplay, subIcon);

  const labelBadge = document.createElement('div');
  labelBadge.className = 'ps-hud-label';
  labelBadge.textContent = label;

  row.append(disc, labelBadge);

  row.addEventListener('pointerenter', () => uiSounds.playHover('default'));

  if (onWheel !== undefined) {
    row.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 0.02 : -0.02;
      uiSounds.playOsd('change');
      onWheel(delta);
    }, { passive: false });
  }

  return {
    root: row,
    setFraction(fraction: number): void {
      const clamped = Math.max(0, Math.min(1, fraction));
      const percent = Math.round(clamped * 100);
      valueDisplay.textContent = String(percent);

      const offset = ARC_LENGTH * (1 - clamped);
      arcFill.setAttribute('stroke-dashoffset', String(offset));
      subIcon.innerHTML = speakerSvg(percent === 0);
    },
    setActive(active: boolean): void {
      row.classList.toggle('ps-hud-active', active);
    },
  };
}

export function buildVolumeMeter(callbacks: VolumeMeterCallbacks = {}): VolumeMeterHandle {
  const root = document.createElement('div');
  root.className = 'ps-hud-overlay';
  root.setAttribute('aria-hidden', 'true');

  const volumeStack = document.createElement('div');
  volumeStack.className = 'ps-hud-stack';

  // Top disc: 音效 (Effects)
  const effectsUnit = createDiscUnit('音效', callbacks.onAdjustEffects);
  // Bottom disc: 音乐 (Music)
  const musicUnit = createDiscUnit('音乐', callbacks.onAdjustMusic);

  volumeStack.append(effectsUnit.root, musicUnit.root);

  // Seek HUD container (shown during seeking)
  const seekRow = document.createElement('div');
  seekRow.className = 'ps-hud-row ps-hud-seek-row';
  seekRow.style.display = 'none';

  const seekDisc = document.createElement('div');
  seekDisc.className = 'ps-hud-disc';

  const seekSvgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  seekSvgEl.setAttribute('viewBox', '0 0 100 100');
  seekSvgEl.setAttribute('class', 'ps-hud-svg');

  const seekArcBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  seekArcBg.setAttribute('cx', '50');
  seekArcBg.setAttribute('cy', '50');
  seekArcBg.setAttribute('r', '42');
  seekArcBg.setAttribute('fill', 'none');
  seekArcBg.setAttribute('class', 'ps-hud-arc-bg');
  seekArcBg.setAttribute('stroke-dasharray', `${ARC_LENGTH} ${CIRCUMFERENCE}`);
  seekArcBg.setAttribute('transform', 'rotate(135 50 50)');

  const seekArcFill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  seekArcFill.setAttribute('cx', '50');
  seekArcFill.setAttribute('cy', '50');
  seekArcFill.setAttribute('r', '42');
  seekArcFill.setAttribute('fill', 'none');
  seekArcFill.setAttribute('class', 'ps-hud-arc-fill ps-hud-seek-fill');
  seekArcFill.setAttribute('stroke-dasharray', `${ARC_LENGTH} ${CIRCUMFERENCE}`);
  seekArcFill.setAttribute('stroke-dashoffset', String(ARC_LENGTH));
  seekArcFill.setAttribute('transform', 'rotate(135 50 50)');

  seekSvgEl.append(seekArcBg, seekArcFill);

  const seekValue = document.createElement('span');
  seekValue.className = 'ps-hud-value ps-hud-seek-value';
  seekValue.textContent = '0:00';

  const seekIcon = document.createElement('div');
  seekIcon.className = 'ps-hud-icon';

  seekDisc.append(seekSvgEl, seekValue, seekIcon);

  const seekLabel = document.createElement('div');
  seekLabel.className = 'ps-hud-label';
  seekLabel.textContent = '+0s';

  seekRow.append(seekDisc, seekLabel);

  root.append(volumeStack, seekRow);

  let hideTimer: number | null = null;
  let isHovered = false;

  const startHideTimer = (durationMs = 1400): void => {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!isHovered) {
        root.classList.remove('ps-hud-visible');
      }
      hideTimer = null;
    }, durationMs);
  };

  const show = (durationMs = 1400): void => {
    root.classList.add('ps-hud-visible');
    startHideTimer(durationMs);
  };

  root.addEventListener('pointerenter', () => {
    isHovered = true;
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });

  root.addEventListener('pointerleave', () => {
    isHovered = false;
    startHideTimer(1000);
  });

  return {
    root,
    showVolumes(musicFraction: number, effectsFraction: number): void {
      seekRow.style.display = 'none';
      volumeStack.style.display = 'flex';

      musicUnit.setFraction(musicFraction);
      effectsUnit.setFraction(effectsFraction);

      musicUnit.setActive(true);
      effectsUnit.setActive(true);
      uiSounds.playOsd('change');
      show(1400);
    },
    showMusicVolume(musicFraction: number): void {
      seekRow.style.display = 'none';
      volumeStack.style.display = 'flex';

      musicUnit.setFraction(musicFraction);
      musicUnit.setActive(true);
      effectsUnit.setActive(false);
      uiSounds.playOsd(musicFraction === 0 ? 'off' : 'change');
      show(1400);
    },
    showEffectsVolume(effectsFraction: number): void {
      seekRow.style.display = 'none';
      volumeStack.style.display = 'flex';

      effectsUnit.setFraction(effectsFraction);
      effectsUnit.setActive(true);
      musicUnit.setActive(false);
      uiSounds.playOsd(effectsFraction === 0 ? 'off' : 'change');
      show(1400);
    },
    showSeek(targetMs: number, deltaMs: number, totalDurationMs: number): void {
      volumeStack.style.display = 'none';
      seekRow.style.display = 'flex';

      const fraction = totalDurationMs > 0 ? Math.max(0, Math.min(1, targetMs / totalDurationMs)) : 0;
      seekValue.textContent = formatMinSec(targetMs);

      const sign = deltaMs >= 0 ? '+' : '';
      const deltaSec = (deltaMs / 1000).toFixed(deltaMs % 1000 === 0 ? 0 : 1);
      seekLabel.textContent = `${sign}${deltaSec}s`;

      const offset = ARC_LENGTH * (1 - fraction);
      seekArcFill.setAttribute('stroke-dashoffset', String(offset));
      seekIcon.innerHTML = seekSvg(deltaMs >= 0);

      uiSounds.playOsd('change');
      show(1400);
    },
    destroy(): void {
      if (hideTimer !== null) clearTimeout(hideTimer);
      root.remove();
    },
  };
}

export function volumeMeterCss(): string {
  return `
/* Floating circular volume HUD (osu!lazer stacked meters) */
.ps-hud-overlay {
  position: absolute;
  left: 36px;
  bottom: 60px;
  display: flex;
  flex-direction: column;
  pointer-events: none;
  z-index: 30;
  opacity: 0;
  transform: scale(0.85) translateY(10px);
  transition: opacity 160ms cubic-bezier(0.2, 0, 0, 1),
              transform 160ms cubic-bezier(0.2, 0, 0, 1);
}
.ps-hud-overlay.ps-hud-visible {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1) translateY(0);
}
.ps-hud-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ps-hud-row {
  display: flex;
  align-items: center;
  pointer-events: auto;
  cursor: pointer;
  opacity: 0.85;
  transform: scale(0.96);
  transition: opacity 120ms ease, transform 120ms ease;
}
.ps-hud-row:hover,
.ps-hud-row.ps-hud-active {
  opacity: 1;
  transform: scale(1);
}
.ps-hud-row:hover .ps-hud-disc {
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7), inset 0 0 0 1.5px rgba(255, 204, 34, 0.5);
}
.ps-hud-disc {
  position: relative;
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: rgba(18, 18, 24, 0.9);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.65), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  transition: box-shadow 150ms ease;
}
.ps-hud-svg {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.ps-hud-arc-bg {
  stroke: rgba(255, 255, 255, 0.12);
  stroke-width: 4;
  stroke-linecap: round;
}
.ps-hud-arc-fill {
  stroke: ${ACCENT};
  stroke-width: 4;
  stroke-linecap: round;
  transition: stroke-dashoffset 80ms ease;
  filter: drop-shadow(0 0 4px rgba(255, 204, 34, 0.5));
}
.ps-hud-seek-fill {
  stroke: #55ccff;
  filter: drop-shadow(0 0 4px rgba(85, 204, 255, 0.5));
}
.ps-hud-value {
  font-family: inherit;
  font-size: 34px;
  font-weight: 700;
  color: #ffffff;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
  margin-top: -2px;
}
.ps-hud-seek-value {
  font-size: 22px;
}
.ps-hud-icon {
  margin-top: 3px;
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ps-hud-label {
  margin-left: -14px;
  padding: 4px 14px 4px 20px;
  border-radius: 999px;
  background: rgba(16, 16, 22, 0.86);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  font-size: 12.5px;
  font-weight: 600;
  color: #ffffff;
  letter-spacing: 0.04em;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  white-space: nowrap;
  user-select: none;
}
`;
}

