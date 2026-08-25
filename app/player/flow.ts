/**
 * The screen flow this app is built around, kept separate from the widgets it drives.
 *
 * Load a replay → the results panel reveals → "watch replay" switches to fullscreen playback →
 * playback ending switches back. Two screens, one owner, so a stray reveal or a leaked session
 * has one place to be cancelled.
 *
 * Deliberately does not own how a replay is *fetched*: the dev page supplies parsed inputs, so
 * the same flow serves a URL, a file drop, or a fixture.
 */

import type { CoreSession } from '../../src/index.js';
import { buildResultsPanel, resultsPanelCss, type ResultsPanelData } from '../results/panel.js';
import { prepareReveal, startReveal } from '../results/reveal.js';
import type { Cancellable } from '../results/animate.js';
import {
  buildSettingsOverlay, settingsOverlayCss,
  type SettingsOverlayHandle, type SettingsSection,
} from './settings.js';

export interface FlowOptions {
  /** Where both screens mount. */
  readonly host: HTMLElement;
  /** The canvas the engine renders into; supplied by the caller so it can size it. */
  readonly canvas: HTMLCanvasElement;
}

export interface LoadedReplay {
  readonly session: CoreSession;
  readonly panel: ResultsPanelData;
  /** Presentation ms to start from; the engine's intro trim already accounts for lead-in. */
  readonly startAtMs: number;
}

export interface FlowHandle {
  /** Shows the results panel for a freshly loaded replay and plays the reveal. */
  present(replay: LoadedReplay): void;
  /** Tears down the current replay, if any. */
  clear(): void;
}

/** Injects both stylesheets once. */
function ensureStyles(): void {
  if (document.getElementById('rv-flow-styles') !== null) return;
  const style = document.createElement('style');
  style.id = 'rv-flow-styles';
  style.textContent = `${resultsPanelCss()}\n${settingsOverlayCss()}\n${flowCss()}`;
  document.head.append(style);
}

function flowCss(): string {
  return `
.rv-flow { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
.rv-screen {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  transition: opacity 200ms ease;
}
.rv-screen[hidden] { display: none; }
.rv-results { overflow-y: auto; padding: 24px 0; }
.rv-playback { background: #000; }
.rv-playback canvas {
  max-width: 100%; max-height: 100%;
  width: auto; height: auto;
  display: block;
}
/* A hint that the settings live off the right edge, shown only while nothing is open. */
.rv-edge-hint {
  position: absolute; top: 50%; right: 0; transform: translateY(-50%);
  width: 4px; height: 64px; border-radius: 2px 0 0 2px;
  background: rgba(255, 204, 34, 0.5);
  pointer-events: none;
  transition: opacity 200ms ease;
}
.rv-back {
  position: absolute; top: 16px; left: 16px;
  border: none; border-radius: 8px;
  background: rgba(0, 0, 0, 0.55); color: #fff;
  font: inherit; font-size: 13px; padding: 8px 14px; cursor: pointer;
  z-index: 21;
}
.rv-back:hover { background: rgba(0, 0, 0, 0.75); }
`;
}

/**
 * Builds the settings sections from a live session. Only controls that drive something are
 * included — see settings.ts for why the ones lazer shows and this engine lacks are absent.
 */
export function sessionSettings(session: CoreSession): readonly SettingsSection[] {
  const { renderer, audioSync } = session;
  const options = renderer.options;

  const playback: SettingsSection = {
    title: 'Playback',
    controls: [
      {
        kind: 'slider',
        label: 'Playback speed',
        min: 0.25, max: 2, step: 0.05, value: 1,
        format: v => `${v.toFixed(2)}x`,
        resetTo: 1,
        onChange: v => {
          audioSync.setUserRate(v);
          // A rate change needs a seek in place to re-anchor the hitsound schedule.
          void audioSync.seekTo(audioSync.currentTimeMs);
        },
      },
    ],
  };

  const display: SettingsSection = {
    title: 'Display',
    controls: [
      {
        kind: 'slider',
        label: 'Background dim',
        min: 0, max: 1, step: 0.05, value: options.backgroundDim,
        format: v => `${Math.round(v * 100)}%`,
        resetTo: 0.8,
        onChange: v => { options.backgroundDim = v; },
      },
      {
        kind: 'toggle', label: 'Storyboard', value: options.showStoryboard, resetTo: true,
        onChange: v => { options.showStoryboard = v; },
      },
      {
        kind: 'toggle', label: 'Key overlay', value: options.showKeyOverlay, resetTo: true,
        onChange: v => { options.showKeyOverlay = v; },
      },
      {
        kind: 'toggle', label: 'Judgements', value: options.showJudgement, resetTo: true,
        onChange: v => { options.showJudgement = v; },
      },
      {
        kind: 'toggle', label: 'Unstable rate bar', value: options.showURBar, resetTo: true,
        onChange: v => { options.showURBar = v; },
      },
      {
        kind: 'toggle', label: 'Follow points', value: options.showFollowpoints, resetTo: true,
        onChange: v => { options.showFollowpoints = v; },
      },
      {
        kind: 'toggle', label: 'Mod icons', value: options.showModIcons, resetTo: true,
        onChange: v => { options.showModIcons = v; },
      },
    ],
  };

  const audio: SettingsSection = {
    title: 'Audio',
    controls: [
      {
        kind: 'slider', label: 'Music volume',
        min: 0, max: 1, step: 0.05, value: 0.25,
        format: v => `${Math.round(v * 100)}%`,
        resetTo: 0.25,
        onChange: v => audioSync.setSongVolume(v),
      },
      {
        kind: 'slider', label: 'Effects volume',
        min: 0, max: 1, step: 0.05, value: 0.25,
        format: v => `${Math.round(v * 100)}%`,
        resetTo: 0.25,
        onChange: v => audioSync.setEffectsVolume(v),
      },
      {
        kind: 'toggle', label: 'Beatmap hitsounds', value: true, resetTo: true,
        onChange: v => audioSync.setBeatmapHitsounds(v),
      },
      {
        kind: 'slider', label: 'Audio offset',
        min: -200, max: 200, step: 1, value: options.audioOffsetMs,
        format: v => `${v > 0 ? '+' : ''}${v} ms`,
        resetTo: 0,
        onChange: v => { options.audioOffsetMs = v; },
      },
    ],
  };

  return [playback, display, audio];
}

export function buildFlow(flowOptions: FlowOptions): FlowHandle {
  ensureStyles();
  const { host, canvas } = flowOptions;

  const flow = document.createElement('div');
  flow.className = 'rv-flow';

  const resultsScreen = document.createElement('div');
  resultsScreen.className = 'rv-screen rv-results';

  const playbackScreen = document.createElement('div');
  playbackScreen.className = 'rv-screen rv-playback';
  playbackScreen.hidden = true;
  playbackScreen.append(canvas);

  const edgeHint = document.createElement('div');
  edgeHint.className = 'rv-edge-hint';
  playbackScreen.append(edgeHint);

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'rv-back';
  back.textContent = '← Results';
  playbackScreen.append(back);

  flow.append(resultsScreen, playbackScreen);
  host.append(flow);

  let current: LoadedReplay | null = null;
  let reveal: Cancellable | null = null;
  let overlay: SettingsOverlayHandle | null = null;
  let endPoll: number | null = null;

  function stopPlayback(): void {
    if (endPoll !== null) { clearInterval(endPoll); endPoll = null; }
    if (current === null) return;
    current.session.player.pause();
    current.session.renderer.stop();
  }

  function showResults(): void {
    stopPlayback();
    overlay?.hide();
    playbackScreen.hidden = true;
    resultsScreen.hidden = false;
  }

  function startPlayback(): void {
    if (current === null) return;
    resultsScreen.hidden = true;
    playbackScreen.hidden = false;

    const { session, startAtMs } = current;
    overlay?.destroy();
    overlay = buildSettingsOverlay(sessionSettings(session), playbackScreen);
    playbackScreen.append(overlay.root);
    // Hide the edge hint once the panel has been found; it is only a discovery aid.
    playbackScreen.addEventListener('pointermove', () => {
      if (overlay?.visible === true) edgeHint.style.opacity = '0';
    }, { once: false });

    session.renderer.start();
    session.player.setClockFn(session.audioSync.clockFn);
    void session.audioSync.playFrom(startAtMs).then(() => {
      session.player.seek(startAtMs);
      session.player.play();
    });

    // The engine exposes no "finished" event, so the flow watches the clock. Polling at 250 ms
    // is imperceptible against a replay's length and avoids wiring a callback into the player.
    endPoll = window.setInterval(() => {
      if (current === null) return;
      const duration = current.session.timeMapper.presentationDurationMs;
      if (current.session.audioSync.currentTimeMs >= duration - 50) showResults();
    }, 250);
  }

  return {
    present(replay: LoadedReplay): void {
      this.clear();
      current = replay;

      const handle = buildResultsPanel(replay.panel, startPlayback);
      resultsScreen.replaceChildren(handle.root);
      resultsScreen.hidden = false;
      playbackScreen.hidden = true;

      prepareReveal(handle);
      reveal = startReveal(handle);
    },
    clear(): void {
      reveal?.cancel();
      reveal = null;
      stopPlayback();
      overlay?.destroy();
      overlay = null;
      if (current !== null) {
        current.session.destroy();
        current = null;
      }
      resultsScreen.replaceChildren();
    },
  };
}
