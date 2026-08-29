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
  type SettingsOverlayHandle, type SettingsSection, type SliderHandle,
} from './settings.js';
import { icon } from '../results/icons.js';
import { buildTransport, transportCss, type TransportHandle } from './transport.js';
import {
  buildVolumeMeter, volumeMeterCss, KeyAccelerator, type VolumeMeterHandle,
} from './volume-meter.js';
import { uiSounds, VOL_KEYS, readStoredVolume, writeStoredVolume } from './uiSounds.js';
import { buildPlayerLoader, playerLoaderCss, type PlayerLoaderHandle } from './playerLoader.js';
import { t } from './i18n.js';

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
  /** Toggles the in-playback settings overlay (slides in/out). */
  toggleSettings(): void;
  /** Tears down the current replay, if any. */
  clear(): void;
}

/** Injects all stylesheets once. */
function ensureStyles(): void {
  if (document.getElementById('rv-flow-styles') !== null) return;
  const style = document.createElement('style');
  style.id = 'rv-flow-styles';
  style.textContent = [
    resultsPanelCss(), settingsOverlayCss(), transportCss(), volumeMeterCss(), playerLoaderCss(), flowCss(),
  ].join('\n');
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
.rv-results {
  overflow-y: auto;
  padding: 24px 0;
  align-items: flex-start;
}
.rv-results > * {
  margin: auto 0;
}
.rv-playback { background: #000; }
.rv-playback canvas {
  max-width: 100%; max-height: 100%;
  width: auto; height: auto;
  display: block;
}
.rv-playback.pl-playfield-in canvas {
  animation: plPlayfieldEnter 750ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
@keyframes plPlayfieldEnter {
  0% { transform: scale(0.7); opacity: 0; }
  33% { opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}
/* The transport row is opaque, so the canvas is inset above it rather than running underneath —
   otherwise the engine's own bottom HUD (combo, unstable-rate bar) is hidden behind it. */
.rv-playback { padding-bottom: 40px; }
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
  display: inline-flex; align-items: center; gap: 7px;
  border: none; border-radius: 8px;
  background: rgba(0, 0, 0, 0.55); color: #fff;
  font: inherit; font-size: 13px; padding: 8px 14px; cursor: pointer;
  z-index: 21;
}
.rv-back:hover { background: rgba(0, 0, 0, 0.75); }
`;
}

export interface SessionSettingsResult {
  readonly sections: readonly SettingsSection[];
  readonly adjustVolume: (delta: number) => void;
  readonly adjustMusicOnly: (delta: number) => void;
  readonly adjustEffectsOnly: (delta: number) => void;
}

/**
 * Builds the settings sections from a live session. Only controls that drive something are
 * included — see settings.ts for why the ones lazer shows and this engine lacks are absent.
 */
export function sessionSettings(
  session: CoreSession,
  volumeMeter?: VolumeMeterHandle | null,
): SessionSettingsResult {
  const { renderer, audioSync } = session;
  const options = renderer.options;

  /** Parses percentage inputs (e.g. "80", "12.3", "120%", "-5"). Decimals round up, clamps to 0-100. */
  const parsePercentInput = (raw: string): number | null => {
    const cleaned = raw.trim().replace(/%/g, '');
    if (cleaned === '') return null;
    const num = parseFloat(cleaned);
    if (Number.isNaN(num)) return null;
    const rounded = Math.ceil(num);
    const clamped = Math.max(0, Math.min(100, rounded));
    return clamped / 100;
  };

  const playback: SettingsSection = {
    title: t('播放', 'Playback'),
    controls: [
      {
        kind: 'slider',
        label: t('播放速度', 'Playback speed'),
        min: 0.25, max: 2, step: 0.01, value: 1,
        format: v => `${v.toFixed(2)}x`,
        resetTo: 1,
        parseInput: raw => {
          const n = parseFloat(raw.trim().replace(/x/gi, ''));
          return Number.isNaN(n) ? null : Math.max(0.25, Math.min(2, n));
        },
        getEditText: v => v.toFixed(2),
        onChange: v => {
          audioSync.setUserRate(v);
          // A rate change needs a seek in place to re-anchor the hitsound schedule.
          void audioSync.seekTo(audioSync.currentTimeMs);
        },
      },
    ],
  };

  const display: SettingsSection = {
    title: t('画面', 'Display'),
    controls: [
      {
        kind: 'slider',
        label: t('背景暗化', 'Background dim'),
        min: 0, max: 1, step: 0.01, value: options.backgroundDim,
        format: v => `${Math.round(v * 100)}%`,
        resetTo: 0.8,
        parseInput: parsePercentInput,
        getEditText: v => String(Math.round(v * 100)),
        onChange: v => { options.backgroundDim = v; },
      },
      {
        kind: 'toggle', label: t('故事版', 'Storyboard'), value: options.showStoryboard, resetTo: true,
        onChange: v => { options.showStoryboard = v; },
      },
      {
        kind: 'toggle', label: t('按键显示', 'Key overlay'), value: options.showKeyOverlay, resetTo: true,
        onChange: v => { options.showKeyOverlay = v; },
      },
      {
        kind: 'toggle', label: t('判定显示', 'Judgements'), value: options.showJudgement, resetTo: true,
        onChange: v => { options.showJudgement = v; },
      },
      {
        kind: 'toggle', label: t('UR 误差条', 'Unstable rate bar'), value: options.showURBar, resetTo: true,
        onChange: v => { options.showURBar = v; },
      },
      {
        kind: 'toggle', label: t('跟随时条', 'Follow points'), value: options.showFollowpoints, resetTo: true,
        onChange: v => { options.showFollowpoints = v; },
      },
      {
        kind: 'toggle', label: t('Mod 图标', 'Mod icons'), value: options.showModIcons, resetTo: true,
        onChange: v => { options.showModIcons = v; },
      },
    ],
  };

  let musicHandle: SliderHandle | null = null;
  let effectsHandle: SliderHandle | null = null;
  let isVolumeLinked = false;
  let linkBtn: HTMLButtonElement | null = null;
  let currentSongVolume = readStoredVolume(VOL_KEYS.music, 0.25);
  let currentEffectsVolume = readStoredVolume(VOL_KEYS.effects, 0.25);

  audioSync.setSongVolume(currentSongVolume);
  audioSync.setEffectsVolume(currentEffectsVolume);

  const updateLinkUi = () => {
    if (linkBtn !== null) {
      linkBtn.classList.toggle('ps-linked', isVolumeLinked);
      linkBtn.setAttribute('aria-pressed', String(isVolumeLinked));
      linkBtn.title = isVolumeLinked
        ? t('音量已联动同步。点击取消联动。', 'Volumes are linked. Click to unlink.')
        : t('联动音乐与音效音量', 'Link Music and Effects volumes');
    }
  };

  const handleLinkToggle = () => {
    isVolumeLinked = !isVolumeLinked;
    uiSounds.playToggle(isVolumeLinked);
    updateLinkUi();
    if (isVolumeLinked && musicHandle !== null && effectsHandle !== null) {
      const m = musicHandle.getValue();
      const e = effectsHandle.getValue();
      if (m !== e) {
        const minVal = Math.min(m, e);
        currentSongVolume = minVal;
        currentEffectsVolume = minVal;
        writeStoredVolume(VOL_KEYS.music, minVal);
        writeStoredVolume(VOL_KEYS.effects, minVal);
        musicHandle.setValue(minVal, true);
        effectsHandle.setValue(minVal, true);
      }
    }
  };

  const onMusicChange = (v: number) => {
    currentSongVolume = v;
    audioSync.setSongVolume(v);
    writeStoredVolume(VOL_KEYS.music, v);
    if (isVolumeLinked && effectsHandle !== null) {
      currentEffectsVolume = v;
      effectsHandle.setValue(v, false);
      audioSync.setEffectsVolume(v);
      writeStoredVolume(VOL_KEYS.effects, v);
      volumeMeter?.showVolumes(v, v);
    } else {
      volumeMeter?.showMusicVolume(v);
    }
  };

  const onEffectsChange = (v: number) => {
    currentEffectsVolume = v;
    audioSync.setEffectsVolume(v);
    writeStoredVolume(VOL_KEYS.effects, v);
    if (isVolumeLinked && musicHandle !== null) {
      currentSongVolume = v;
      musicHandle.setValue(v, false);
      audioSync.setSongVolume(v);
      writeStoredVolume(VOL_KEYS.music, v);
      volumeMeter?.showVolumes(v, v);
    } else {
      volumeMeter?.showEffectsVolume(v);
    }
  };

  const adjustVolume = (delta: number): void => {
    if (isVolumeLinked) {
      const next = Math.max(0, Math.min(1, Math.round((currentSongVolume + delta) * 100) / 100));
      currentSongVolume = next;
      currentEffectsVolume = next;
      audioSync.setSongVolume(next);
      audioSync.setEffectsVolume(next);
      writeStoredVolume(VOL_KEYS.music, next);
      writeStoredVolume(VOL_KEYS.effects, next);
      musicHandle?.setValue(next, false);
      effectsHandle?.setValue(next, false);
      volumeMeter?.showVolumes(next, next);
    } else {
      const nextMusic = Math.max(0, Math.min(1, Math.round((currentSongVolume + delta) * 100) / 100));
      const nextEffects = Math.max(0, Math.min(1, Math.round((currentEffectsVolume + delta) * 100) / 100));
      currentSongVolume = nextMusic;
      currentEffectsVolume = nextEffects;
      audioSync.setSongVolume(nextMusic);
      audioSync.setEffectsVolume(nextEffects);
      writeStoredVolume(VOL_KEYS.music, nextMusic);
      writeStoredVolume(VOL_KEYS.effects, nextEffects);
      musicHandle?.setValue(nextMusic, false);
      effectsHandle?.setValue(nextEffects, false);
      volumeMeter?.showVolumes(nextMusic, nextEffects);
    }
  };

  const adjustMusicOnly = (delta: number): void => {
    const next = Math.max(0, Math.min(1, Math.round((currentSongVolume + delta) * 100) / 100));
    currentSongVolume = next;
    audioSync.setSongVolume(next);
    writeStoredVolume(VOL_KEYS.music, next);
    musicHandle?.setValue(next, false);
    if (isVolumeLinked && effectsHandle !== null) {
      currentEffectsVolume = next;
      audioSync.setEffectsVolume(next);
      writeStoredVolume(VOL_KEYS.effects, next);
      effectsHandle.setValue(next, false);
      volumeMeter?.showVolumes(next, next);
    } else {
      volumeMeter?.showMusicVolume(next);
    }
  };

  const adjustEffectsOnly = (delta: number): void => {
    const next = Math.max(0, Math.min(1, Math.round((currentEffectsVolume + delta) * 100) / 100));
    currentEffectsVolume = next;
    audioSync.setEffectsVolume(next);
    writeStoredVolume(VOL_KEYS.effects, next);
    effectsHandle?.setValue(next, false);
    if (isVolumeLinked && musicHandle !== null) {
      currentSongVolume = next;
      audioSync.setSongVolume(next);
      writeStoredVolume(VOL_KEYS.music, next);
      musicHandle.setValue(next, false);
      volumeMeter?.showVolumes(next, next);
    } else {
      volumeMeter?.showEffectsVolume(next);
    }
  };

  const buildVolumeLinkDivider = (): HTMLElement => {
    const divider = document.createElement('div');
    divider.className = 'ps-volume-link-divider';

    const lineLeft = document.createElement('div');
    lineLeft.className = 'ps-volume-link-line';

    linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'ps-volume-link-btn';
    linkBtn.setAttribute('aria-label', t('联动音乐与音效音量', 'Link Music and Effects volumes'));
    uiSounds.attachHoverClick(linkBtn, { hover: 'button', click: false });

    const linkText = document.createElement('span');
    linkText.className = 'ps-volume-link-text';
    linkText.textContent = t('同步', 'Link');

    linkBtn.append(
      icon('link', { className: 'rv-icon' }),
      linkText,
    );
    linkBtn.addEventListener('click', handleLinkToggle);
    updateLinkUi();

    const lineRight = document.createElement('div');
    lineRight.className = 'ps-volume-link-line';

    divider.append(lineLeft, linkBtn, lineRight);
    return divider;
  };

  const audio: SettingsSection = {
    title: t('音频', 'Audio'),
    controls: [
      {
        kind: 'slider', label: t('音乐音量', 'Music volume'),
        min: 0, max: 1, step: 0.01, value: currentSongVolume,
        format: v => `${Math.round(v * 100)}%`,
        resetTo: 0.25,
        bindHandle: h => { musicHandle = h; },
        parseInput: parsePercentInput,
        getEditText: v => String(Math.round(v * 100)),
        onChange: onMusicChange,
      },
      {
        kind: 'custom',
        render: buildVolumeLinkDivider,
      },
      {
        kind: 'slider', label: t('音效音量', 'Effects volume'),
        min: 0, max: 1, step: 0.01, value: currentEffectsVolume,
        format: v => `${Math.round(v * 100)}%`,
        resetTo: 0.25,
        bindHandle: h => { effectsHandle = h; },
        parseInput: parsePercentInput,
        getEditText: v => String(Math.round(v * 100)),
        onChange: onEffectsChange,
      },
      {
        kind: 'toggle', label: t('谱面打击音效', 'Beatmap hitsounds'), value: true, resetTo: true,
        onChange: v => audioSync.setBeatmapHitsounds(v),
      },
      {
        kind: 'slider', label: t('音频偏移', 'Audio offset'),
        min: -200, max: 200, step: 1, value: options.audioOffsetMs,
        format: v => `${v > 0 ? '+' : ''}${v} ms`,
        resetTo: 0,
        parseInput: raw => {
          const n = parseInt(raw.trim().replace(/ms/gi, ''), 10);
          return Number.isNaN(n) ? null : Math.max(-200, Math.min(200, n));
        },
        getEditText: v => String(v),
        onChange: v => { options.audioOffsetMs = v; },
      },
      {
        kind: 'slider', label: t('界面音效音量', 'UI sound volume'),
        min: 0, max: 1, step: 0.01, value: uiSounds.getVolume(),
        format: v => `${Math.round(v * 100)}%`,
        resetTo: 0.25,
        parseInput: parsePercentInput,
        getEditText: v => String(Math.round(v * 100)),
        onChange: v => { uiSounds.setVolume(v); },
      },
    ],
  };

  return { sections: [playback, display, audio], adjustVolume, adjustMusicOnly, adjustEffectsOnly };
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
  const backLabel = document.createElement('span');
  backLabel.textContent = 'Results';
  back.append(icon('arrow-left', { className: 'rv-icon' }), backLabel);
  uiSounds.attachHoverClick(back, { hover: 'button', click: false });
  // `showResults` is a hoisted function declaration below, so referencing it here is fine — and
  // without this listener the button was decoration: it rendered and did nothing.
  back.addEventListener('click', () => {
    uiSounds.playClick('button');
    showResults();
  });
  playbackScreen.append(back);

  flow.append(resultsScreen, playbackScreen);
  host.append(flow);

  let current: LoadedReplay | null = null;
  let reveal: Cancellable | null = null;
  let loader: PlayerLoaderHandle | null = null;
  let overlay: SettingsOverlayHandle | null = null;
  let transport: TransportHandle | null = null;
  let volumeMeter: VolumeMeterHandle | null = null;
  let endPoll: number | null = null;
  let keydownListener: ((e: KeyboardEvent) => void) | null = null;
  let wheelListener: ((e: WheelEvent) => void) | null = null;

  function stopPlayback(): void {
    if (endPoll !== null) { clearInterval(endPoll); endPoll = null; }
    if (keydownListener !== null) {
      window.removeEventListener('keydown', keydownListener);
      keydownListener = null;
    }
    if (wheelListener !== null) {
      playbackScreen.removeEventListener('wheel', wheelListener);
      wheelListener = null;
    }
    volumeMeter?.destroy();
    volumeMeter = null;
    transport?.destroy();
    transport = null;
    if (current === null) return;
    current.session.audioSync.pause();
    current.session.player.pause();
    current.session.renderer.stop();
  }

  function showResults(): void {
    stopPlayback();
    loader?.destroy();
    loader = null;
    overlay?.hide();
    playbackScreen.hidden = true;
    if (current !== null) {
      reveal?.cancel();
      reveal = null;
      uiSounds.stopAll();
      const handle = buildResultsPanel(current.panel, enterPlayerLoader);
      resultsScreen.replaceChildren(handle.root);
      resultsScreen.hidden = false;
      prepareReveal(handle);
      reveal = startReveal(handle);
    } else {
      resultsScreen.hidden = false;
    }
  }

  function enterPlayerLoader(): void {
    if (current === null) return;
    reveal?.cancel();
    reveal = null;
    uiSounds.stopAll();
    resultsScreen.hidden = true;
    loader?.destroy();

    loader = buildPlayerLoader({
      host: flow,
      session: current.session,
      panel: current.panel,
      onReady: () => {
        loader = null;
        startPlayback();
      },
      onCancel: () => {
        loader = null;
        showResults();
      },
    });
    loader.start();
  }

  function startPlayback(): void {
    if (current === null) return;
    reveal?.cancel();
    reveal = null;
    uiSounds.stopAll();
    resultsScreen.hidden = true;
    playbackScreen.hidden = false;
    playbackScreen.classList.remove('pl-playfield-in');
    void playbackScreen.offsetWidth; // Trigger reflow
    playbackScreen.classList.add('pl-playfield-in');
    setTimeout(() => {
      playbackScreen.classList.remove('pl-playfield-in');
    }, 800);

    const { session, startAtMs } = current;
    if (startAtMs > 0) {
      uiSounds.play('submit-select', { volume: 0.8 });
    }
    overlay?.destroy();
    transport?.destroy();
    volumeMeter?.destroy();

    transport = buildTransport(session);

    let adjustVolumeFn = (_delta: number) => {};
    let adjustMusicOnlyFn = (_delta: number) => {};
    let adjustEffectsOnlyFn = (_delta: number) => {};

    volumeMeter = buildVolumeMeter({
      onAdjustMusic: delta => adjustMusicOnlyFn(delta),
      onAdjustEffects: delta => adjustEffectsOnlyFn(delta),
    });

    const { sections, adjustVolume, adjustMusicOnly, adjustEffectsOnly } = sessionSettings(session, volumeMeter);
    adjustVolumeFn = adjustVolume;
    adjustMusicOnlyFn = adjustMusicOnly;
    adjustEffectsOnlyFn = adjustEffectsOnly;

    overlay = buildSettingsOverlay(sections, playbackScreen);
    // The transport buttons live inside the top settings card (Playback) above the speed slider,
    // as lazer arranges them.
    const firstCard = overlay.root.querySelector('.ps-card');
    if (firstCard !== null) {
      firstCard.prepend(transport.buttons);
    } else {
      overlay.root.prepend(transport.buttons);
    }
    playbackScreen.append(overlay.root, transport.scrubber, volumeMeter.root);
    transport.start();
    // Hide the edge hint once the panel has been found; it is only a discovery aid.
    playbackScreen.addEventListener('pointermove', () => {
      if (overlay?.visible === true) edgeHint.style.opacity = '0';
    }, { once: false });

    // Keyboard & Wheel Hotkeys
    const volumeAccelerator = new KeyAccelerator(0.01, 8, 300);
    const seekAccelerator = new KeyAccelerator(1000, 10, 320);

    keydownListener = (e: KeyboardEvent) => {
      if (current === null || playbackScreen.hidden) return;
      // Do not intercept if user is typing in a text/input box
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        if (session.audioSync.isPlaying) {
          session.audioSync.pause();
          session.player.pause();
        } else {
          const duration = session.timeMapper.presentationDurationMs;
          const from = session.audioSync.currentTimeMs >= duration - 50 ? 0 : session.audioSync.currentTimeMs;
          void session.audioSync.playFrom(from).then(() => {
            session.player.seek(from);
            session.player.play();
          });
        }
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        const delta = volumeAccelerator.getDelta();
        adjustVolumeFn(delta);
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        const delta = volumeAccelerator.getDelta();
        adjustVolumeFn(-delta);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const delta = seekAccelerator.getDelta();
        const currentMs = session.audioSync.currentTimeMs;
        const targetMs = Math.max(0, currentMs - delta);
        void session.audioSync.seekTo(targetMs);
        session.player.seek(targetMs);
        volumeMeter?.showSeek(targetMs, -delta, session.timeMapper.presentationDurationMs);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        const delta = seekAccelerator.getDelta();
        const currentMs = session.audioSync.currentTimeMs;
        const duration = session.timeMapper.presentationDurationMs;
        const targetMs = Math.min(duration, currentMs + delta);
        void session.audioSync.seekTo(targetMs);
        session.player.seek(targetMs);
        volumeMeter?.showSeek(targetMs, delta, duration);
      }
    };
    window.addEventListener('keydown', keydownListener);

    wheelListener = (e: WheelEvent) => {
      if (current === null || playbackScreen.hidden) return;
      if (overlay?.root.contains(e.target as Node)) return;
      if (volumeMeter?.root.contains(e.target as Node)) return;
      e.preventDefault();
      // Mouse wheel is linear: 2% per notch
      const delta = e.deltaY < 0 ? 0.02 : -0.02;
      adjustVolumeFn(delta);
    };
    playbackScreen.addEventListener('wheel', wheelListener, { passive: false });

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
      // Only while actually playing: seeking to the end while paused should stay there rather
      // than bouncing back to the results panel.
      if (!current.session.audioSync.isPlaying) return;
      const duration = current.session.timeMapper.presentationDurationMs;
      if (current.session.audioSync.currentTimeMs >= duration - 50) showResults();
    }, 250);
  }

  return {
    present(replay: LoadedReplay): void {
      this.clear();
      current = replay;
      showResults();
    },
    toggleSettings(): void {
      if (overlay !== null) {
        if (overlay.visible) overlay.hide();
        else overlay.show();
      }
    },
    clear(): void {
      reveal?.cancel();
      reveal = null;
      loader?.destroy();
      loader = null;
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
