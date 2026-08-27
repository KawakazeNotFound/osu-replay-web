/**
 * osu!lazer-accurate UI sound effect system.
 *
 * Implements sample caching, AudioContext gain routing, rate limiting/debouncing
 * (replicating lazer's HoverSampleDebounceComponent), and high-level interaction helpers.
 */

/**
 * Every sample this app plays.
 *
 * Exhaustive on purpose. This union used to end in `(string & {})`, which keeps autocomplete but
 * accepts any string — so a mistyped name typechecked and then silently played nothing, and the
 * `Results/` samples were absent from the list while being played at ten call sites. That gap also
 * made an audit of which files are actually reachable report sixteen in-use sounds as dead; they
 * were nearly deleted on the strength of it.
 *
 * Names with a prefix (`Results/`, `UI/`) mirror osu-resources' own folders. The loader resolves
 * by basename against a flat assets/ui-sounds, so the prefix is documentation rather than a path.
 */
export type UiSampleName =
  | 'Results/applause-a'
  | 'Results/applause-b'
  | 'Results/applause-c'
  | 'Results/applause-d'
  | 'Results/applause-s'
  | 'Results/badge-dink'
  | 'Results/badge-dink-max'
  | 'Results/rank-impact-fail'
  | 'Results/rank-impact-fail-d'
  | 'Results/rank-impact-pass'
  | 'Results/rank-impact-pass-ss'
  | 'Results/score-panel-focus'
  | 'Results/score-panel-top-appear'
  | 'Results/score-tick'
  | 'Results/swoosh-up'
  | 'UI/overlay-pop-in'
  | 'button-hover'
  | 'button-select'
  | 'button-sidebar-hover'
  | 'button-sidebar-select'
  | 'check-off'
  | 'check-on'
  | 'default-hover'
  | 'default-select'
  | 'default-select-disabled'
  | 'dialog-cancel-select'
  | 'dialog-dangerous-select'
  | 'dialog-ok-select'
  | 'dialog-pop-in'
  | 'dialog-pop-out'
  | 'dropdown-close'
  | 'dropdown-open'
  | 'generic-error'
  | 'menu-close'
  | 'menu-open'
  | 'menu-sub-open'
  | 'notch-tick'
  | 'notification-default'
  | 'notification-done'
  | 'notification-error'
  | 'osd-change'
  | 'osd-off'
  | 'osd-on'
  | 'overlay-big-pop-in'
  | 'overlay-big-pop-out'
  | 'submit-select'
  | 'screen-back'
  | 'shutter'
  | 'settings-pop-in'
  | 'wave-pop-in'
  | 'wave-pop-out'
  | 'tabselect-select';
export interface PlaySampleOptions {
  readonly volume?: number;
  readonly pitch?: number;
  readonly debounceMs?: number;
}

export const VOL_KEYS = {
  music: 'rv_music_volume',
  effects: 'rv_effects_volume',
  ui: 'rv_ui_volume',
} as const;

export function readStoredVolume(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const num = parseFloat(raw);
      if (!Number.isNaN(num) && num >= 0 && num <= 1) {
        return Math.round(num * 100) / 100;
      }
    }
  } catch {}
  return fallback;
}

export function writeStoredVolume(key: string, val: number): void {
  try {
    localStorage.setItem(key, String(Math.round(val * 100) / 100));
  } catch {}
}

class UiSoundManager {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private readonly bufferCache = new Map<string, AudioBuffer>();
  private readonly loadingPromises = new Map<string, Promise<AudioBuffer>>();
  private readonly lastPlayTimes = new Map<string, number>();
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private readonly activeTickingStopFns = new Set<() => void>();
  private generation = 0;
  private uiVolume = readStoredVolume(VOL_KEYS.ui, 0.25);
  private muted = false;

  /** Stops all currently playing UI sounds immediately. */
  stopAll(): void {
    this.generation++;
    for (const source of this.activeSources) {
      try {
        source.stop(0);
        source.disconnect();
      } catch {}
    }
    this.activeSources.clear();

    for (const stopFn of this.activeTickingStopFns) {
      try {
        stopFn();
      } catch {}
    }
    this.activeTickingStopFns.clear();
  }

  /** Sets or shares the Web Audio AudioContext */
  setAudioContext(ctx: AudioContext): void {
    if (this.audioContext === ctx) return;
    this.audioContext = ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.setValueAtTime(this.muted ? 0 : this.uiVolume, ctx.currentTime);
    this.gainNode.connect(ctx.destination);
  }

  getAudioContext(): AudioContext {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      this.setAudioContext(ctx);
      return ctx;
    }
    return this.audioContext;
  }

  setVolume(volumeFraction: number): void {
    this.uiVolume = Math.max(0, Math.min(1, Math.round(volumeFraction * 100) / 100));
    writeStoredVolume(VOL_KEYS.ui, this.uiVolume);
    if (this.audioContext && this.gainNode) {
      const targetGain = this.muted ? 0 : this.uiVolume;
      this.gainNode.gain.setValueAtTime(targetGain, this.audioContext.currentTime);
    }
  }

  getVolume(): number {
    return this.uiVolume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audioContext && this.gainNode) {
      const targetGain = this.muted ? 0 : this.uiVolume;
      this.gainNode.gain.setValueAtTime(targetGain, this.audioContext.currentTime);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Preloads a list of samples in the background. */
  preload(samples: readonly UiSampleName[]): void {
    for (const sample of samples) {
      // Intentionally leave rejection visible as an unhandled rejection. A missing canonical
      // asset is a broken build, not an optional sound to hide behind a warning.
      void this.loadBuffer(sample);
    }
  }

  private async loadBuffer(sample: UiSampleName): Promise<AudioBuffer> {
    if (this.bufferCache.has(sample)) {
      return this.bufferCache.get(sample)!;
    }
    if (this.loadingPromises.has(sample)) {
      return this.loadingPromises.get(sample)!;
    }

    // One URL, not a cascade. Every runtime sample resolves inside assets/ui-sounds by basename,
    // and build-app validates the complete manifest before copying anything. A miss here is a
    // genuinely broken build, worth surfacing rather than papering over with six more requests.
    // The previous seven-candidate fallback also forced the build to copy the same bytes to six
    // destinations so that *something* would answer.
    const baseName = sample.includes('/') ? sample.split('/').pop()! : sample;
    const url = `/assets/ui-sounds/${baseName}.wav`;

    const promise = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`[uiSounds] ${url} returned HTTP ${res.status} for sample "${sample}"`);
        }
        const arrayBuf = await res.arrayBuffer();
        const ctx = this.getAudioContext();
        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        this.bufferCache.set(sample, audioBuf);
        return audioBuf;
      } finally {
        this.loadingPromises.delete(sample);
      }
    })();

    this.loadingPromises.set(sample, promise);
    return promise;
  }

  /** Plays a UI sample with optional volume, pitch adjustment and debounce. */
  play(sample: UiSampleName, options?: PlaySampleOptions): void {
    if (this.muted || this.uiVolume <= 0.001) return;

    const now = performance.now();
    const debounceMs = options?.debounceMs ?? 0;
    if (debounceMs > 0) {
      const last = this.lastPlayTimes.get(sample) ?? 0;
      if (now - last < debounceMs) return;
    }
    this.lastPlayTimes.set(sample, now);

    const ctx = this.getAudioContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const currentGen = this.generation;
    void this.loadBuffer(sample).then(buffer => {
      if (this.generation !== currentGen) return;
      if (!this.gainNode || !this.audioContext) return;
      try {
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;

        if (options?.pitch && options.pitch !== 1) {
          source.playbackRate.setValueAtTime(options.pitch, this.audioContext.currentTime);
        }

        if (options?.volume && options.volume !== 1) {
          const sampleGain = this.audioContext.createGain();
          sampleGain.gain.setValueAtTime(options.volume, this.audioContext.currentTime);
          source.connect(sampleGain);
          sampleGain.connect(this.gainNode);
        } else {
          source.connect(this.gainNode);
        }

        this.activeSources.add(source);
        source.onended = () => {
          this.activeSources.delete(source);
        };
        source.start(0);
      } catch (err) {
        console.error('[uiSounds] play error:', err);
      }
    });
  }

  // ---- High-level Semantic Sound Helpers (lazer accurate) -----------------------------

  /** Replicates lazer HoverSounds / HoverClickSounds */
  playHover(type: 'default' | 'button' | 'sidebar' = 'default'): void {
    switch (type) {
      case 'button':
        this.play('button-hover', { debounceMs: 25 });
        break;
      case 'sidebar':
        this.play('button-sidebar-hover', { debounceMs: 25 });
        break;
      case 'default':
      default:
        this.play('default-hover', { debounceMs: 25 });
        break;
    }
  }

  playClick(type: 'default' | 'button' | 'sidebar' | 'dialog-ok' | 'dialog-cancel' | 'dialog-dangerous' | 'disabled' = 'default'): void {
    switch (type) {
      case 'button':
        this.play('button-select');
        break;
      case 'sidebar':
        this.play('button-sidebar-select');
        break;
      case 'dialog-ok':
        this.play('dialog-ok-select');
        break;
      case 'dialog-cancel':
        this.play('dialog-cancel-select');
        break;
      case 'dialog-dangerous':
        this.play('dialog-dangerous-select');
        break;
      case 'disabled':
        this.play('default-select-disabled');
        break;
      case 'default':
      default:
        this.play('default-select');
        break;
    }
  }

  playToggle(checked: boolean): void {
    this.play(checked ? 'check-on' : 'check-off');
  }

  playDropdown(isOpen: boolean): void {
    this.play(isOpen ? 'dropdown-open' : 'dropdown-close');
  }

  playMenu(action: 'open' | 'close' | 'sub-open'): void {
    switch (action) {
      case 'open':
        this.play('menu-open');
        break;
      case 'close':
        this.play('menu-close');
        break;
      case 'sub-open':
        this.play('menu-sub-open');
        break;
    }
  }

  playDialog(action: 'pop-in' | 'pop-out'): void {
    this.play(action === 'pop-in' ? 'dialog-pop-in' : 'dialog-pop-out');
  }

  playDrawer(action: 'open' | 'close'): void {
    this.play(action === 'open' ? 'overlay-big-pop-in' : 'overlay-big-pop-out');
  }

  playSliderTick(): void {
    this.play('notch-tick', { debounceMs: 30 });
  }

  playOsd(action: 'change' | 'on' | 'off'): void {
    switch (action) {
      case 'change':
        this.play('osd-change', { debounceMs: 20 });
        break;
      case 'on':
        this.play('osd-on');
        break;
      case 'off':
        this.play('osd-off');
        break;
    }
  }

  playNotification(type: 'default' | 'done' | 'error' = 'default'): void {
    switch (type) {
      case 'done':
        this.play('notification-done');
        break;
      case 'error':
        this.play('notification-error');
        break;
      case 'default':
      default:
        this.play('notification-default');
        break;
    }
  }

  playError(): void {
    this.play('generic-error');
  }

  // ---- Results Screen Sound Helpers (lazer accurate) -----------------------------

  playScorePanelFocus(): void {
    const pitch = 0.99 + Math.random() * 0.2;
    this.play('Results/score-panel-focus', { pitch });
  }

  playScorePanelTopAppear(): void {
    this.play('Results/score-panel-top-appear');
  }

  playSwooshUp(): void {
    this.play('Results/swoosh-up', { volume: 0.4 });
  }

  startScoreTicking(targetAccuracy: number): { stop: () => void } {
    let stopped = false;
    let timerId: number | null = null;
    const startMs = performance.now();
    const durationMs = 1500;
    const outSine = (t: number) => Math.sin((t * Math.PI) / 2);

    const tick = () => {
      if (stopped) return;
      const elapsed = performance.now() - startMs;
      if (elapsed >= durationMs) {
        stopped = true;
        return;
      }
      const progress = Math.min(1, elapsed / durationMs);
      const eased = outSine(progress);

      // Debounce transforms 18ms -> 300ms
      const intervalMs = 18 + (300 - 18) * eased;
      // Frequency transforms 1.0 -> 1 + targetAccuracy
      const pitch = 1.0 + targetAccuracy * eased;
      // Volume transforms 0.6 -> 1.0
      const volume = 0.6 + (1.0 - 0.6) * eased;

      this.play('Results/score-tick', { pitch, volume });

      timerId = window.setTimeout(tick, intervalMs);
    };

    tick();

    const stopFn = () => {
      stopped = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      this.activeTickingStopFns.delete(stopFn);
    };

    this.activeTickingStopFns.add(stopFn);

    return { stop: stopFn };
  }

  playBadgeDink(badgeNum: number, isMax: boolean): void {
    if (isMax) {
      this.play('Results/badge-dink-max');
    } else {
      this.play('Results/badge-dink', { pitch: 1 + badgeNum * 0.05 });
    }
  }

  playRankImpact(rank: string): void {
    const norm = rank.toUpperCase();
    if (norm === 'X' || norm === 'XH' || norm === 'SS' || norm === 'SSH') {
      this.play('Results/rank-impact-pass-ss');
    } else if (norm === 'S' || norm === 'SH' || norm === 'A') {
      this.play('Results/rank-impact-pass');
    } else if (norm === 'B' || norm === 'C') {
      this.play('Results/rank-impact-fail');
    } else {
      this.play('Results/rank-impact-fail-d');
    }
  }

  playApplause(rank: string): void {
    const norm = rank.toUpperCase();
    // Typed rather than inferred as string: with the union now exhaustive, this is what makes a
    // mistyped branch a compile error instead of a silent 404 at the moment of applause.
    let sample: UiSampleName = 'Results/applause-s';
    if (norm === 'X' || norm === 'XH' || norm === 'SS' || norm === 'SSH' || norm === 'S' || norm === 'SH') {
      sample = 'Results/applause-s';
    } else if (norm === 'A') {
      sample = 'Results/applause-a';
    } else if (norm === 'B') {
      sample = 'Results/applause-b';
    } else if (norm === 'C') {
      sample = 'Results/applause-c';
    } else {
      sample = 'Results/applause-d';
    }
    this.play(sample, { volume: 0.8 });
  }

  /**
   * Helper to attach hover and click sound behaviors to a DOM element.
   */
  attachHoverClick(
    element: HTMLElement,
    options?: {
      readonly hover?: 'default' | 'button' | 'sidebar' | false;
      readonly click?: 'default' | 'button' | 'sidebar' | 'dialog-ok' | 'dialog-cancel' | 'dialog-dangerous' | false;
      readonly isEnabled?: () => boolean;
    },
  ): void {
    const hoverType = options?.hover !== undefined ? options.hover : 'default';
    const clickType = options?.click !== undefined ? options.click : 'default';

    if (hoverType !== false) {
      element.addEventListener('pointerenter', () => {
        if (options?.isEnabled && !options.isEnabled()) return;
        this.playHover(hoverType);
      });
    }

    if (clickType !== false) {
      element.addEventListener('click', () => {
        if (options?.isEnabled && !options.isEnabled()) {
          this.playClick('disabled');
          return;
        }
        this.playClick(clickType);
      });
    }
  }
}

/** Singleton UI sound manager instance */
/**
 * The one manager, parked on a global key rather than held by module scope.
 *
 * Module scope is not the singleton boundary a bundler guarantees. esbuild inlines a shared module
 * into every entry point that imports it unless code splitting is on, and the dev server compiles
 * each module as its own bundle where splitting is not even possible — so `new UiSoundManager()`
 * at module scope ran once per bundle. Measured before this: eleven copies, each preloading, and a
 * mute toggle that silenced only the copy it happened to be holding.
 *
 * Keying off globalThis makes the instance genuinely shared however the code is bundled, which is
 * the property the mute state and volume actually need.
 */
const GLOBAL_KEY = '__rvUiSounds';
type WithManager = typeof globalThis & { [GLOBAL_KEY]?: UiSoundManager };

function sharedManager(): UiSoundManager {
  const host = globalThis as WithManager;
  host[GLOBAL_KEY] ??= new UiSoundManager();
  return host[GLOBAL_KEY];
}

export const uiSounds = sharedManager();

/**
 * Interaction sounds only, preloaded because they must be instant — a hover or click sound that
 * arrives after a network round trip reads as a bug.
 *
 * Deliberately excluded: everything under Results/. Those play at most once, on a reveal that
 * begins with a 450 ms delay and runs for three seconds, so `play()` fetching them on demand is
 * comfortably in time. They are also the heavy ones — the five applause variants alone are 3.6 MB
 * of the 6.5 MB this list used to pull on first paint, for audio most visitors never reach.
 */
if (!(globalThis as WithManager & { __rvUiPreloaded?: boolean }).__rvUiPreloaded) {
  (globalThis as WithManager & { __rvUiPreloaded?: boolean }).__rvUiPreloaded = true;
  uiSounds.preload([
    'button-hover',
    'button-select',
    'default-hover',
    'default-select',
    'default-select-disabled',
    'check-on',
    'check-off',
    'menu-open',
    'menu-close',
    'menu-sub-open',
    'dropdown-open',
    'dropdown-close',
    'dialog-pop-in',
    'dialog-pop-out',
    'dialog-ok-select',
    'dialog-cancel-select',
    'osd-change',
    'notch-tick',
  ]);
}
