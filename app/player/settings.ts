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

/** osu!'s Yellow, `OsuColour.Yellow` = #ffcc22 — the accent lazer's settings use. */
const ACCENT = '#ffcc22';

/** Fraction of the viewport width that counts as the right edge trigger. */
export const EDGE_TRIGGER_FRACTION = 0.2;

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
}

export interface ToggleSpec {
  readonly kind: 'toggle';
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly resetTo?: boolean;
}

export type ControlSpec = SliderSpec | ToggleSpec;

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
  button.textContent = '↺';
  button.addEventListener('click', onReset);
  return button;
}

function buildSlider(spec: SliderSpec): HTMLElement {
  const row = el('div', 'ps-row ps-row-slider');

  const head = el('div', 'ps-row-head');
  if (spec.resetTo !== undefined) head.append(resetButton(() => { input.value = String(spec.resetTo); apply(); }));
  head.append(el('span', 'ps-label', spec.label));
  const readout = el('span', 'ps-value', spec.format(spec.value));
  head.append(readout);
  row.append(head);

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'ps-slider';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);

  const apply = (): void => {
    const value = Number(input.value);
    readout.textContent = spec.format(value);
    // The filled portion is painted with a gradient rather than a pseudo-element so it works
    // across engines without vendor-specific track styling.
    const fraction = (value - spec.min) / (spec.max - spec.min);
    input.style.setProperty('--ps-fill', `${fraction * 100}%`);
    spec.onChange(value);
  };
  input.addEventListener('input', apply);
  row.append(input);
  apply();
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
      card.append(control.kind === 'slider' ? buildSlider(control) : buildToggle(control));
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
  background: rgba(12, 12, 12, 0.82);
  backdrop-filter: blur(8px);
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
  background: #1f1f1f;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 12px;
}
.ps-card-title {
  margin: 0;
  font-size: 14px; font-weight: 600;
  color: #ffffff;
}
.ps-row { display: flex; flex-direction: column; gap: 6px; }
.ps-row-toggle { flex-direction: row; align-items: center; gap: 8px; }
.ps-row-head { display: flex; align-items: center; gap: 8px; }
.ps-label { flex: 1; color: #e8e8e8; }
.ps-value { color: #ffffff; font-weight: 600; font-variant-numeric: tabular-nums; }
.ps-reset {
  width: 18px; height: 18px; flex: 0 0 auto;
  border: none; border-radius: 50%;
  background: transparent; color: #b18cff;
  font-size: 13px; line-height: 1; cursor: pointer; padding: 0;
}
.ps-reset:hover { color: #d0b8ff; }

/* Slider: a flat track with a wide pill thumb, filled to the current value. */
.ps-slider {
  --ps-fill: 0%;
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 18px;
  background: transparent; cursor: pointer;
}
.ps-slider::-webkit-slider-runnable-track {
  height: 18px; border-radius: 9px;
  background: linear-gradient(to right, ${ACCENT} var(--ps-fill), #3a3a3a var(--ps-fill));
}
.ps-slider::-moz-range-track {
  height: 18px; border-radius: 9px;
  background: linear-gradient(to right, ${ACCENT} var(--ps-fill), #3a3a3a var(--ps-fill));
}
.ps-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 34px; height: 18px; border: none; border-radius: 9px;
  background: ${ACCENT};
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}
.ps-slider::-moz-range-thumb {
  width: 34px; height: 18px; border: none; border-radius: 9px;
  background: ${ACCENT};
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
