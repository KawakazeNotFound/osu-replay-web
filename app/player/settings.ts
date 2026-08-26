/**
 * The in-playback settings overlay: a column of cards that slides in from the right edge, as
 * osu!lazer's replay settings do.
 *
 * It appears when the pointer enters the right edge of the screen and slides back out when it
 * leaves — so it costs no screen space while watching, and needs no button.
 *
 * Controls are only rendered when they actually drive something. lazer's own panel lists
 * background blur, beatmap skin, combo-colour normalisation and a cursor heatmap; this engine
 * has none of those, and a control that moves nothing is worse than an absent one. What it
 * does have beyond lazer's list — judgement display, UR bar, mod icons, follow points, separate
 * music and effects volume — is included.
 *
 * Labels are English to match the rest of the app. lazer localises its own; swapping these is a
 * data change, not a code one.
 */

import { icon } from '../results/icons.js';

/** osu!'s Yellow, `OsuColour.Yellow` = #ffcc22 — the accent lazer's settings use. */
const ACCENT = '#ffcc22';

/** Fraction of the viewport width that counts as the right edge trigger. */
export const EDGE_TRIGGER_FRACTION = 0.2;

export interface SliderHandle {
  getValue(): number;
  setValue(val: number, notify?: boolean): void;
}

export interface SliderSpec {
  readonly kind: 'slider';
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  /** Formats the value for display, e.g. `1.00x` or `80%`. */
  readonly format: (value: number) => string;
  readonly onChange: (value: number) => void;
  /** Shows a reset affordance that restores this value. */
  readonly resetTo?: number;
  /** Exposes a handle to control this slider externally (e.g. linked sliders). */
  readonly bindHandle?: (handle: SliderHandle) => void;
  /** Custom parser when user manually enters a value by clicking the readout. */
  readonly parseInput?: (inputStr: string) => number | null;
  /** Custom text to show initially in the input box when editing starts. */
  readonly getEditText?: (value: number) => string;
}

export interface ToggleSpec {
  readonly kind: 'toggle';
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly resetTo?: boolean;
}

export interface CustomSpec {
  readonly kind: 'custom';
  readonly render: () => HTMLElement;
}

export type ControlSpec = SliderSpec | ToggleSpec | CustomSpec;

export interface SettingsSection {
  readonly title: string;
  readonly controls: readonly ControlSpec[];
}

export interface SettingsOverlayHandle {
  readonly root: HTMLElement;
  /** Slides in. */
  show(): void;
  /** Slides out. */
  hide(): void;
  readonly visible: boolean;
  /** Removes listeners and the element. */
  destroy(): void;
}

function el(tag: string, className: string, textContent?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

/** A reset arrow, shown only for controls that declare a default. */
function resetButton(onReset: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ps-reset';
  button.title = 'Reset to default';
  button.append(icon('reset', { className: 'rv-icon' }));
  button.addEventListener('click', onReset);
  return button;
}

function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

function buildSlider(spec: SliderSpec): HTMLElement {
  const row = el('div', 'ps-row ps-row-slider');

  let currentValue = spec.value;
  let animFrame: number | null = null;

  const stopAnimation = (): void => {
    if (animFrame !== null) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
  };

  const head = el('div', 'ps-row-head');
  if (spec.resetTo !== undefined) {
    head.append(resetButton(() => {
      animateTo(spec.resetTo!, 240, true);
    }));
  }
  head.append(el('span', 'ps-label', spec.label));
  const readout = el('span', 'ps-value', spec.format(spec.value));
  if (spec.parseInput !== undefined) {
    readout.classList.add('ps-value-editable');
    readout.title = 'Click to edit value';
  }
  head.append(readout);
  row.append(head);

  const container = el('div', 'ps-slider-container');
  container.setAttribute('role', 'slider');
  container.setAttribute('tabindex', '0');
  container.setAttribute('aria-valuemin', String(spec.min));
  container.setAttribute('aria-valuemax', String(spec.max));
  container.setAttribute('aria-valuenow', String(spec.value));

  const track = el('div', 'ps-slider-track');
  const fill = el('div', 'ps-slider-fill');
  track.append(fill);

  const nub = el('div', 'ps-slider-nub');
  container.append(track, nub);
  row.append(container);

  const render = (val: number, notify = true): void => {
    currentValue = val;
    readout.textContent = spec.format(val);
    const fraction = Math.max(0, Math.min(1, (val - spec.min) / (spec.max - spec.min)));
    const pos = `calc(17px + (100% - 34px) * ${fraction})`;
    nub.style.left = pos;
    fill.style.width = pos;
    container.setAttribute('aria-valuenow', String(val));
    if (notify) spec.onChange(val);
  };

  const animateTo = (targetVal: number, durationMs = 240, notify = true): void => {
    stopAnimation();
    const startVal = currentValue;
    if (Math.abs(targetVal - startVal) < 1e-6) {
      render(targetVal, notify);
      return;
    }
    const startTime = performance.now();

    const tick = (now: number): void => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = easeOutQuint(progress);
      const nextVal = startVal + (targetVal - startVal) * eased;
      render(nextVal, notify);
      if (progress < 1) {
        animFrame = requestAnimationFrame(tick);
      } else {
        animFrame = null;
        render(targetVal, notify);
      }
    };
    animFrame = requestAnimationFrame(tick);
  };

  const valueFromPointer = (clientX: number): number => {
    const rect = container.getBoundingClientRect();
    if (rect.width <= 34) return spec.min;
    const offset = clientX - (rect.left + 17);
    const trackSpan = rect.width - 34;
    const fraction = Math.max(0, Math.min(1, offset / trackSpan));
    const rawVal = spec.min + fraction * (spec.max - spec.min);
    if (spec.step > 0) {
      const steps = Math.round((rawVal - spec.min) / spec.step);
      return Math.max(spec.min, Math.min(spec.max, spec.min + steps * spec.step));
    }
    return rawVal;
  };

  let isDragging = false;
  let startX = 0;

  container.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    container.setPointerCapture(e.pointerId);
    isDragging = true;
    startX = e.clientX;
    container.classList.add('ps-dragging');

    const targetVal = valueFromPointer(e.clientX);
    // Smoothly animate with non-linear easeOutQuint to clicked position
    animateTo(targetVal, 220, true);
  });

  container.addEventListener('pointermove', (e: PointerEvent) => {
    if (!isDragging) return;
    if (Math.abs(e.clientX - startX) > 3) {
      stopAnimation();
      const val = valueFromPointer(e.clientX);
      render(val, true);
    }
  });

  const onPointerUp = (e: PointerEvent): void => {
    if (!isDragging) return;
    isDragging = false;
    container.classList.remove('ps-dragging');
    try {
      container.releasePointerCapture(e.pointerId);
    } catch {}
  };

  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);

  // Keyboard navigation
  container.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = spec.step > 0 ? spec.step : (spec.max - spec.min) / 100;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      stopAnimation();
      const next = Math.max(spec.min, currentValue - step);
      animateTo(next, 120, true);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      stopAnimation();
      const next = Math.min(spec.max, currentValue + step);
      animateTo(next, 120, true);
    }
  });

  // Initial render
  render(spec.value, false);

  // Manual input when clicking on the readout
  if (spec.parseInput !== undefined) {
    readout.addEventListener('click', () => {
      if (head.querySelector('.ps-value-input') !== null) return;
      const initialText = spec.getEditText !== undefined
        ? spec.getEditText(currentValue)
        : String(Math.round(currentValue * 100));

      const editInput = document.createElement('input');
      editInput.type = 'text';
      editInput.className = 'ps-value-input';
      editInput.value = initialText;

      let finished = false;
      const commit = (): void => {
        if (finished) return;
        finished = true;
        const parsed = spec.parseInput!(editInput.value);
        if (parsed !== null && !Number.isNaN(parsed)) {
          animateTo(parsed, 200, true);
        } else {
          render(currentValue, false);
        }
        editInput.replaceWith(readout);
      };

      const cancel = (): void => {
        if (finished) return;
        finished = true;
        editInput.replaceWith(readout);
      };

      editInput.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      });

      editInput.addEventListener('blur', () => {
        commit();
      });

      readout.replaceWith(editInput);
      editInput.focus();
      editInput.select();
    });
  }

  if (spec.bindHandle !== undefined) {
    spec.bindHandle({
      getValue: () => currentValue,
      setValue: (val: number, notify = true) => {
        stopAnimation();
        render(val, notify);
      },
    });
  }

  return row;
}

function buildToggle(spec: ToggleSpec): HTMLElement {
  const row = el('div', 'ps-row ps-row-toggle');
  if (spec.resetTo !== undefined) row.append(resetButton(() => set(spec.resetTo!)));
  row.append(el('span', 'ps-label', spec.label));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ps-switch';
  button.setAttribute('role', 'switch');

  let current = spec.value;
  function set(next: boolean): void {
    current = next;
    button.setAttribute('aria-checked', String(next));
    button.classList.toggle('ps-on', next);
    spec.onChange(next);
  }
  button.addEventListener('click', () => set(!current));
  set(current);

  row.append(button);
  return row;
}

/**
 * Builds the overlay and wires the right-edge trigger.
 *
 * `container` is the element whose pointer movement is watched — normally the playback surface,
 * so the overlay does not react while the results panel is up.
 */
export function buildSettingsOverlay(
  sections: readonly SettingsSection[],
  container: HTMLElement,
): SettingsOverlayHandle {
  const root = el('aside', 'ps-overlay');
  root.setAttribute('aria-label', 'Replay settings');

  for (const section of sections) {
    if (section.controls.length === 0) continue;
    const card = el('section', 'ps-card');
    card.append(el('h3', 'ps-card-title', section.title));
    for (const control of section.controls) {
      if (control.kind === 'slider') card.append(buildSlider(control));
      else if (control.kind === 'toggle') card.append(buildToggle(control));
      else if (control.kind === 'custom') card.append(control.render());
    }
    root.append(card);
  }

  let visible = false;
  const show = (): void => {
    if (visible) return;
    visible = true;
    root.classList.add('ps-visible');
  };
  const hide = (): void => {
    if (!visible) return;
    visible = false;
    root.classList.remove('ps-visible');
  };

  const onPointerMove = (event: PointerEvent): void => {
    const width = container.clientWidth;
    if (width === 0) return;
    const threshold = width * (1 - EDGE_TRIGGER_FRACTION);
    // Measured against the container, not the window, so an embedded surface behaves the same.
    const x = event.clientX - container.getBoundingClientRect().left;
    if (x >= threshold) show();
    else if (!root.matches(':hover')) hide();
  };
  // Keep it open while the pointer is inside it, even if that means leaving the trigger band —
  // dragging a slider near the panel's left edge would otherwise dismiss it mid-drag.
  const onOverlayLeave = (): void => {
    const width = container.clientWidth;
    if (width === 0) return;
    hide();
  };

  container.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerleave', onOverlayLeave);

  return {
    root,
    show,
    hide,
    get visible(): boolean { return visible; },
    destroy(): void {
      container.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerleave', onOverlayLeave);
      root.remove();
    },
  };
}

/** Stylesheet for the overlay. */
export function settingsOverlayCss(): string {
  return `
.ps-overlay {
  position: absolute;
  top: 0; right: 0; bottom: 0;
  width: 330px;
  box-sizing: border-box;
  padding: 14px;
  display: flex; flex-direction: column; gap: 12px;
  overflow-y: auto;
  /* Transparent container so the playfield and artwork behind remain clearly visible */
  background: transparent;
  color: #ffffff;
  font-size: 13px;
  /* Parked just off-screen; slides in rather than fading, matching lazer's push-in. */
  transform: translateX(100%);
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none;
  z-index: 20;
  scrollbar-width: thin;
}
.ps-overlay.ps-visible { transform: none; pointer-events: auto; }
.ps-card {
  /* Each category block is transparent by default so the background shines through clearly.
     It darkens to a solid focus block only when hovered or focused. */
  background: rgba(16, 16, 22, 0.22);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 12px;
  transition: background 200ms cubic-bezier(0.2, 0, 0, 1),
              border-color 200ms ease,
              backdrop-filter 200ms ease,
              box-shadow 200ms ease;
}
.ps-card:hover,
.ps-card:focus-within {
  background: rgba(22, 22, 28, 0.94);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}
.ps-card-title {
  margin: 0;
  font-size: 14px; font-weight: 600;
  color: #ffffff;
  /* Text sits over moving gameplay, so it carries its own shadow rather than relying on the
     panel's tint for contrast. */
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
}
.ps-row { display: flex; flex-direction: column; gap: 6px; }
.ps-row-toggle { flex-direction: row; align-items: center; gap: 8px; }
.ps-row-head { display: flex; align-items: center; gap: 8px; }
.ps-label { flex: 1; color: #f0f0f0; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); }
.ps-value {
  color: #ffffff; font-weight: 600; font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  padding: 1px 4px;
  border-radius: 4px;
  transition: all 120ms ease;
}
.ps-value-editable {
  cursor: pointer;
  border-bottom: 1px dotted rgba(255, 255, 255, 0.35);
}
.ps-value-editable:hover {
  background: rgba(255, 255, 255, 0.12);
  color: ${ACCENT};
  border-bottom-color: ${ACCENT};
}
.ps-value-input {
  width: 52px;
  height: 20px;
  background: rgba(15, 24, 48, 0.85);
  color: ${ACCENT};
  border: 1px solid ${ACCENT};
  border-radius: 4px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: right;
  padding: 0 4px;
  box-sizing: border-box;
  outline: none;
  box-shadow: 0 0 6px rgba(255, 204, 34, 0.35);
}
.ps-reset {
  width: 18px; height: 18px; flex: 0 0 auto;
  border: none; border-radius: 50%;
  background: transparent; color: #b18cff;
  font-size: 15px; line-height: 1; cursor: pointer; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
}
.ps-reset:hover { color: #d0b8ff; }

/* Thin slider track with smooth pill nub (osu!lazer style) */
.ps-slider-container {
  position: relative;
  width: 100%;
  height: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  outline: none;
}
.ps-slider-track {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.16);
}
.ps-slider-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0%;
  background: ${ACCENT};
  border-radius: 2px;
}
.ps-slider-nub {
  position: absolute;
  top: 50%;
  width: 34px;
  height: 14px;
  border-radius: 7px;
  background: ${ACCENT};
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: transform 80ms ease, box-shadow 120ms ease;
}
.ps-slider-container:hover .ps-slider-nub {
  box-shadow: 0 0 8px rgba(255, 204, 34, 0.6);
}
.ps-slider-container.ps-dragging .ps-slider-nub {
  transform: translate(-50%, -50%) scale(1.05);
  box-shadow: 0 0 10px rgba(255, 204, 34, 0.85);
}
.ps-slider-container:focus-visible .ps-slider-track {
  box-shadow: 0 0 0 2px rgba(255, 204, 34, 0.4);
}

/* Volume link divider between Music volume and Effects volume */
.ps-volume-link-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 1px 0;
  padding: 0 2px;
}
.ps-volume-link-line {
  flex: 1;
  height: 1px;
  background: rgba(255, 255, 255, 0.12);
  transition: background 150ms ease;
}
.ps-volume-link-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(20, 20, 26, 0.6);
  color: rgba(255, 255, 255, 0.65);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 150ms ease;
}
.ps-volume-link-btn:hover {
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.35);
  background: rgba(40, 40, 50, 0.8);
}
.ps-volume-link-btn.ps-linked {
  color: ${ACCENT};
  border-color: rgba(255, 204, 34, 0.55);
  background: rgba(255, 204, 34, 0.14);
  box-shadow: 0 0 8px rgba(255, 204, 34, 0.25);
}
.ps-volume-link-btn.ps-linked .rv-icon {
  color: ${ACCENT};
}
.ps-volume-link-divider:has(.ps-linked) .ps-volume-link-line {
  background: linear-gradient(to right, rgba(255, 204, 34, 0.1), rgba(255, 204, 34, 0.4), rgba(255, 204, 34, 0.1));
}
.ps-volume-link-text {
  letter-spacing: 0.03em;
}

/* Toggle: a filled pill when on, an outlined one when off — as lazer draws it. */
.ps-switch {
  width: 52px; height: 20px; flex: 0 0 auto;
  border-radius: 10px;
  border: 2px solid ${ACCENT};
  background: transparent;
  cursor: pointer;
  transition: background 120ms ease;
}
.ps-switch.ps-on { background: ${ACCENT}; }
`;
}
