/**
 * Playback transport: the button row and the scrub bar.
 *
 * Split in two because they belong in different places. The reference screenshot puts the
 * transport buttons at the top of the right-hand settings panel, directly above the playback
 * speed slider — so that is where they go. A scrub bar, though, is no use behind a panel you have
 * to summon, so it sits along the bottom of the playback surface and stays visible.
 *
 * Every seek goes through both clocks. The player reads its time from AudioSync (the flow calls
 * `setClockFn(audioSync.clockFn)`), so moving one without the other desynchronises visuals from
 * audio — `audioSync.seekTo` alone leaves the renderer on the old frame until the next tick.
 */

import type { CoreSession } from '../../src/index.js';
import { icon, type IconName } from '../results/icons.js';

/** Coarse and fine jumps, in presentation ms. */
const JUMP_COARSE_MS = 5000;
const JUMP_FINE_MS = 1000;

export interface TransportHandle {
  /** The button row, meant for the settings overlay's top. */
  readonly buttons: HTMLElement;
  /** The scrub bar, meant for the bottom of the playback surface. */
  readonly scrubber: HTMLElement;
  /** Starts the clock-driven UI refresh. */
  start(): void;
  /** Stops refreshing and detaches listeners. */
  destroy(): void;
}

function button(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'pt-button';
  node.title = title;
  node.setAttribute('aria-label', title);
  node.append(icon(name, { className: 'rv-icon' }));
  node.addEventListener('click', onClick);
  return node;
}

/** `m:ss` — replays run minutes, so an hour field would be dead weight. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function buildTransport(session: CoreSession): TransportHandle {
  const { player, audioSync, timeMapper } = session;
  const durationMs = timeMapper.presentationDurationMs;

  // ---- state helpers ----------------------------------------------------------------

  /** Moves both clocks together. Resumes only if it was already playing. */
  const seekTo = (ms: number): void => {
    const clamped = Math.max(0, Math.min(durationMs, ms));
    void audioSync.seekTo(clamped);
    player.seek(clamped);
    render();
  };

  const togglePlay = (): void => {
    if (audioSync.isPlaying) {
      audioSync.pause();
      player.pause();
    } else {
      // At the very end, play would have nothing left — restart from the top instead of
      // appearing to do nothing.
      const from = audioSync.currentTimeMs >= durationMs - 50 ? 0 : audioSync.currentTimeMs;
      void audioSync.playFrom(from).then(() => {
        player.seek(from);
        player.play();
      });
    }
    render();
  };

  // ---- buttons ----------------------------------------------------------------------

  const buttons = document.createElement('div');
  buttons.className = 'pt-buttons';

  buttons.append(
    button('skip-start', 'Restart', () => seekTo(0)),
    button('rewind', `Back ${JUMP_COARSE_MS / 1000}s`, () => seekTo(audioSync.currentTimeMs - JUMP_COARSE_MS)),
    button('step-back', `Back ${JUMP_FINE_MS / 1000}s`, () => seekTo(audioSync.currentTimeMs - JUMP_FINE_MS)),
  );
  const playButton = button('pause', 'Play / pause', togglePlay);
  playButton.classList.add('pt-play');
  buttons.append(
    playButton,
    button('step-forward', `Forward ${JUMP_FINE_MS / 1000}s`, () => seekTo(audioSync.currentTimeMs + JUMP_FINE_MS)),
    button('fast-forward', `Forward ${JUMP_COARSE_MS / 1000}s`, () => seekTo(audioSync.currentTimeMs + JUMP_COARSE_MS)),
    button('skip-end', 'Jump to end', () => seekTo(durationMs)),
  );

  // ---- scrubber ---------------------------------------------------------------------

  const scrubber = document.createElement('div');
  scrubber.className = 'pt-scrubber';

  const elapsed = document.createElement('span');
  elapsed.className = 'pt-time';
  const remaining = document.createElement('span');
  remaining.className = 'pt-time';

  const track = document.createElement('div');
  track.className = 'pt-track';
  const fill = document.createElement('div');
  fill.className = 'pt-fill';
  const knob = document.createElement('div');
  knob.className = 'pt-knob';
  track.append(fill, knob);

  scrubber.append(elapsed, track, remaining);

  /** Pointer x within the track → presentation ms. */
  const msFromPointer = (clientX: number): number => {
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return 0;
    const fraction = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, fraction)) * durationMs;
  };

  let dragging = false;
  // While dragging, the scrub position comes from the pointer rather than the clock: reading the
  // clock would fight the drag, since each seek takes a moment to settle.
  let dragMs = 0;

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    dragMs = msFromPointer(event.clientX);
    track.setPointerCapture(event.pointerId);
    seekTo(dragMs);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    dragMs = msFromPointer(event.clientX);
    seekTo(dragMs);
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };

  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('pointermove', onPointerMove);
  track.addEventListener('pointerup', onPointerUp);
  track.addEventListener('pointercancel', onPointerUp);

  // ---- refresh ----------------------------------------------------------------------

  let raf = 0;

  function render(): void {
    const now = dragging ? dragMs : audioSync.currentTimeMs;
    const fraction = durationMs > 0 ? Math.max(0, Math.min(1, now / durationMs)) : 0;
    fill.style.width = `${fraction * 100}%`;
    knob.style.left = `${fraction * 100}%`;
    elapsed.textContent = formatTime(now);
    remaining.textContent = formatTime(durationMs);
    // Swap the glyph only when it actually changes: this runs every frame, and replacing the
    // child unconditionally would rebuild an SVG 60 times a second.
    const wanted: IconName = audioSync.isPlaying ? 'pause' : 'play';
    if (playButton.dataset['icon'] !== wanted) {
      playButton.dataset['icon'] = wanted;
      playButton.replaceChildren(icon(wanted, { className: 'rv-icon' }));
    }
  }

  const tick = (): void => {
    render();
    raf = requestAnimationFrame(tick);
  };

  return {
    buttons,
    scrubber,
    start(): void {
      if (raf === 0) raf = requestAnimationFrame(tick);
    },
    destroy(): void {
      if (raf !== 0) { cancelAnimationFrame(raf); raf = 0; }
      track.removeEventListener('pointerdown', onPointerDown);
      track.removeEventListener('pointermove', onPointerMove);
      track.removeEventListener('pointerup', onPointerUp);
      track.removeEventListener('pointercancel', onPointerUp);
      buttons.remove();
      scrubber.remove();
    },
  };
}

/** Stylesheet for both parts. */
export function transportCss(): string {
  const accent = '#ffcc22';
  return `
.pt-buttons {
  display: flex; align-items: center; justify-content: center; gap: 2px;
  margin-bottom: 2px;
}
.pt-button {
  border: none; background: transparent; color: #ffffff;
  font-size: 17px; line-height: 1;
  padding: 6px 7px; border-radius: 6px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6));
  transition: background 120ms ease;
}
.pt-button:hover { background: rgba(255, 255, 255, 0.14); }
.pt-play {
  font-size: 21px;
  width: 38px; height: 38px;
  border: 2px solid rgba(255, 255, 255, 0.85); border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  margin: 0 6px;
}

/* Scrub bar: sits on the playback surface, so it is glass rather than a solid strip.
   The engine draws its own HUD along the bottom — the combo counter bottom-left and the
   unstable-rate bar bottom-centre — so this row is pushed clear of both rather than laid over
   them, which made all three unreadable. */
.pt-scrubber {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; gap: 10px;
  padding: 8px 20px 8px;
  /* Own background rather than a gradient over gameplay: the engine's HUD is directly above, so
     a soft fade would leave the bar sitting in a muddy overlap. */
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  z-index: 15;
}
.pt-time {
  color: #ffffff; font-size: 12px; font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  min-width: 34px; text-align: center;
}
.pt-track {
  position: relative; flex: 1; height: 16px;
  display: flex; align-items: center;
  cursor: pointer;
  touch-action: none;
}
/* The visible line is thinner than the hit area: a 4px bar is hard to grab, but a 16px one
   looks heavy. */
.pt-track::before {
  content: ""; position: absolute; left: 0; right: 0; height: 4px;
  border-radius: 2px; background: rgba(255, 255, 255, 0.28);
}
.pt-fill {
  position: absolute; left: 0; height: 4px; width: 0;
  border-radius: 2px; background: ${accent};
}
.pt-knob {
  position: absolute; top: 50%; left: 0;
  width: 12px; height: 12px; border-radius: 50%;
  background: ${accent};
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
`;
}
