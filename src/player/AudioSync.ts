import type { BeatmapData, HitResult, HitSample } from '../types/index.js';
import type { ComboFrame } from '../renderer/HUDRenderer.js';
import type { SbSample } from '../storyboard/types.js';
import type { TaikoInputEvent } from '../rulesets/taiko/input.js';
import { computeHitsoundSchedule, resolveSample, lookupSkinSound } from './hitsoundSchedule.js';
import type { PendingSound } from './hitsoundSchedule.js';
// Pitch-preserved tempo stretch (WSOLA). DT/HT pre-stretch the decoded buffer once at
// construction, then play it via a sample-accurate-seeking buffer source.
import { timeStretch } from './TimeStretch.js';

/**
 * Snapshot of every input needed to reproduce this session's audio offline (e.g. rendering
 * the song + hitsounds into an OfflineAudioContext). Produced by `AudioSync.getMixdownInputs()`;
 * consumers feed it to the same pure schedule/resolve functions in hitsoundSchedule.ts that
 * live playback uses. AudioSync owns this contract. Times are beatmap ms; volumes are 0..1.
 */
export interface MixdownInputs {
  songBuffer: AudioBuffer | null;
  // Active sound map (skin-only or beatmap-merged, per the "Beatmap Hitsounds" toggle).
  skinSounds: ReadonlyMap<string, AudioBuffer>;
  // False ⇒ ignore beatmap custom-file refs so they fall through to the skin's set/type sample.
  beatmapHitsounds: boolean;
  lazerDefaultSounds: ReadonlyMap<string, AudioBuffer> | null;
  beatmap: BeatmapData;
  hitResults: readonly HitResult[];
  mode: 0 | 1 | 2 | 3;
  maniaSamples: ReadonlyMap<number, HitSample> | null;
  taikoGhostTaps: readonly TaikoInputEvent[] | null;
  comboFrames: readonly ComboFrame[];
  introOffsetMs: number;
  oldOffsetMs: number;
  speed: number;
  isNC: boolean;
  // 0..1 volumes, snapshotted from the live gain nodes (= the volume sliders).
  musicVol: number;
  effectsVol: number;
}

/** Look-ahead horizon for pending hitsound flushes (seconds of ctx time). */
const FLUSH_HORIZON_S = 2.0;
/** Interval between look-ahead flushes (ms). Must be < FLUSH_HORIZON_S × 1000. */
const FLUSH_INTERVAL_MS = 500;

/**
 * BASS plays at most this many concurrent voices of one sample handle (osu-framework
 * Sample.DEFAULT_CONCURRENCY), overriding the longest-playing voice past the cap. A
 * mania chord (N columns, same hitsound, same instant) therefore sounds like ~2
 * voices, not N; std stacks and dense taiko/stream sections hit it too. Enforced per
 * resolved-sample identity for all modes, matching osu!'s shared audio path.
 */
const SAMPLE_CONCURRENCY = 2;

/**
 * Live audio engine for a replay session: plays the song and schedules every hitsound on
 * one shared AudioContext, and exposes that hardware clock as the playback time source.
 * `currentTimeMs` returns presentation time in ms (beatmapMs = presMs × speed + introOffsetMs);
 * song and hitsounds are locked to the same AudioContext clock so they can never drift apart.
 * Owns its gain nodes and audio sources, but NOT the AudioContext (see `destroy`).
 */
export class AudioSync {
  private readonly ctx: AudioContext;
  private readonly songBuffer: AudioBuffer | null;
  // Two sound maps for the "Beatmap Hitsounds" toggle: skin-only (skin assets before the
  // beatmap merge) and merged (beatmap samples override skin, osu!'s default). `_activeSounds`
  // picks one by `_beatmapHitsounds`. When OFF, customFile refs are also ignored at flush time
  // so beatmap-named samples fall through to the skin's set/type sample (matches osu!).
  private readonly _skinOnlySounds: Map<string, AudioBuffer>;
  private readonly _mergedSounds: Map<string, AudioBuffer>;
  private _beatmapHitsounds: boolean;
  private readonly hitResults: readonly HitResult[];
  private readonly beatmap: BeatmapData;
  private readonly introOffsetMs: number;
  private readonly speed: number;
  // Pre-v5 maps: visuals run 24ms behind audio; shift hitsounds forward to match the visual hit.
  private readonly oldOffsetMs: number;
  // 0 = std, 1 = taiko, 2 = catch, 3 = mania. Non-std modes own their own hitsound timeline;
  // skip std slider-edge walk or a converted Mode:0 .osu played as taiko/mania/catch
  // sprays phantom slider edges.
  private readonly mode: 0 | 1 | 2 | 3;
  // Mania-only: sourceIndex → HitSample. Holds aren't indexed in beatmap.hitObjects, so
  // the std fallback to `this.beatmap.hitObjects[result.objectIndex]` can't resolve a
  // HoldNote head's sample — this map closes that gap.
  private readonly maniaSamples: ReadonlyMap<number, HitSample> | null;
  // Taiko-only: presses that hit no object, so the drum can sound a bare don/kat for
  // empty-section / warm-up taps on top of the note-tied hitsounds. Null for std/mania.
  private readonly taikoGhostTaps: readonly TaikoInputEvent[] | null;
  // Displayed combo timeline; gates the combo-break sound on osu!'s > 20 rule (std/mania).
  private readonly comboFrames: readonly ComboFrame[];
  // Lazer-default hitsounds (the ppy/osu-resources wavs), used as the cascade fallback
  // below skin lookups and above synth. Only these defaults fill gaps — a skin's own
  // files are never substituted from elsewhere.
  private readonly lazerDefaultSounds: ReadonlyMap<string, AudioBuffer> | null;
  // NC vs DT/HT: NC pitch-shifts the raw buffer (playbackRate = speed); DT/HT preserve pitch by
  // playing a pre-stretched buffer (SoundTouch WSOLA) at rate 1 — same as the offline mixdown.
  private readonly _isNC: boolean;
  // User playback rate (presentation control, not a mod): scales the wall-clock→
  // presentation-time slope and the song source's playbackRate multiplicatively on top of the
  // mod speed. Pitched (no pitch preservation). Never reaches judgement/score or the
  // mixdown snapshot. Floor 0.1 guards the divisions in _startSong/_flushPendingSounds.
  private _userRate: number;

  private readonly synthCache = new Map<string, AudioBuffer>();
  private readonly songGain: GainNode;
  private readonly effectsGain: GainNode;
  private readonly _sbSamples: readonly SbSample[];
  private readonly _sbSampleBuffers: ReadonlyMap<string, AudioBuffer> | null;
  /** Walk position in `_sbSamples`; reset by `_scheduleHitsounds` on play/seek/rate change. */
  private _sbSampleIdx = 0;

  // What we actually feed the buffer source: the raw decoded buffer for nomod/NC, or a
  // pitch-preserved pre-stretched copy for DT/HT. `_playRate` is the playbackRate to pair it
  // with (speed for the raw buffer — pitched, correct for NC; 1 for the pre-stretched buffer).
  private readonly _playBuffer: AudioBuffer | null;
  private readonly _playRate: number;

  private activeSong: AudioBufferSourceNode | null = null;

  private activeHitsounds: AudioBufferSourceNode[] = [];
  private _isPlaying = false;
  private _presTimeAtStart = 0;
  private _ctxTimeAtStart = 0;
  private _pausedPresTime = 0;

  // Pre-creating thousands of AudioBufferSourceNodes starves Chromium's audio thread and
  // glitches song start. Queue records and only flush the next ~2s on a periodic timer.
  private _pendingSounds: PendingSound[] = [];
  private _pendingSoundIdx = 0;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;

  // Per-sample voice tracker (key = resolved sample identity → active voices sorted
  // by start). Enforces the BASS concurrency cap; rebuilt each schedule.
  private _sampleVoices: Map<string, { when: number; endWhen: number; src: AudioBufferSourceNode }[]> | null = null;

  // Bumped on start/stop. playFrom captures it and bails if it changed across the only await
  // (ctx.resume()), so a pause/seek landing mid-resume can't start a song that should be stopped.
  private _playGen = 0;

  constructor(options: {
    ctx: AudioContext;
    songBuffer: AudioBuffer | null;
    // Skin-only sound map (skin assets before the beatmap merge).
    skinSounds: Map<string, AudioBuffer>;
    // Merged map: beatmap samples override skin per stem (osu!'s "Beatmap Hitsounds = ON").
    mergedSounds: Map<string, AudioBuffer>;
    // Initial toggle state; default ON (= current behaviour, beatmap samples win).
    beatmapHitsounds?: boolean;
    hitResults: readonly HitResult[];
    beatmap: BeatmapData;
    introOffsetMs: number;
    speed?: number;
    isNC?: boolean;
    userRate?: number;
    mode?: 0 | 1 | 2 | 3;
    maniaSamples?: ReadonlyMap<number, HitSample> | null;
    taikoGhostTaps?: readonly TaikoInputEvent[] | null;
    comboFrames?: readonly ComboFrame[];
    lazerDefaultSounds?: ReadonlyMap<string, AudioBuffer> | null;
    /**
     * Storyboard `Sample` events on the beatmap timeline, and the buffers to play for them
     * (keyed as `SbSample.lookupPath`). Scheduled alongside hitsounds off the same anchor,
     * so they follow seeks, DT/HT and the user rate without extra bookkeeping.
     */
    storyboardSamples?: readonly SbSample[] | null;
    storyboardSampleBuffers?: ReadonlyMap<string, AudioBuffer> | null;
  }) {
    this.ctx          = options.ctx;
    this.songBuffer   = options.songBuffer;
    this._skinOnlySounds = options.skinSounds;
    this._mergedSounds   = options.mergedSounds;
    this._beatmapHitsounds = options.beatmapHitsounds ?? true;
    this.hitResults   = options.hitResults;
    this.beatmap      = options.beatmap;
    this.introOffsetMs = options.introOffsetMs;
    this.speed        = options.speed ?? 1;
    this.oldOffsetMs  = options.beatmap.formatVersion < 5 ? 24 : 0;
    this.mode         = options.mode ?? 0;
    this.maniaSamples = options.maniaSamples ?? null;
    this.taikoGhostTaps = options.taikoGhostTaps ?? null;
    this.comboFrames  = options.comboFrames ?? [];
    this.lazerDefaultSounds = options.lazerDefaultSounds ?? null;
    // Sorted defensively: .osb files list samples in time order in practice, but the flush
    // loop walks the list once and would silently drop anything out of order.
    this._sbSamples = [...(options.storyboardSamples ?? [])].sort((a, b) => a.time - b.time);
    this._sbSampleBuffers = options.storyboardSampleBuffers ?? null;

    this.songGain    = options.ctx.createGain();
    this.effectsGain = options.ctx.createGain();
    this.songGain.connect(options.ctx.destination);
    this.effectsGain.connect(options.ctx.destination);

    this._isNC = options.isNC ?? false;
    this._userRate = Math.max(0.1, Math.min(2, options.userRate ?? 1));

    // DT/HT (pitch-preserved, non-NC): pre-stretch the decoded buffer ONCE here via WSOLA,
    // then play it at rate 1 with a sample-accurate-seeking AudioBufferSourceNode. A buffer
    // source is used rather than an HTMLMediaElement because encoded-stream seeking is
    // inaccurate on VBR MP3s (a Xing-TOC seek can land ~1s off on a long file).
    // nomod plays the raw buffer at rate 1; NC plays it at rate = speed (pitched, intended).
    // The stretch is synchronous (~1–2s for a full song) but runs once at construction;
    // speed is fixed per instance so it never re-runs mid-playback.
    this._playBuffer = this.songBuffer;
    this._playRate   = this.speed;
    if (this.speed !== 1 && !this._isNC && this.songBuffer !== null) {
      try {
        this._playBuffer = timeStretch(this.songBuffer, this.speed, this.ctx);
        this._playRate   = 1;
      } catch (err) {
        // WSOLA failed — fall back to pitched playback (like NC) so sync still holds.
        console.warn('[AudioSync] DT/HT time-stretch failed; falling back to pitched playback', err);
        this._playBuffer = this.songBuffer;
        this._playRate   = this.speed;
      }
    }
  }

  setSongVolume(v: number): void {
    this.songGain.gain.value = Math.max(0, Math.min(1, v));
  }

  setEffectsVolume(v: number): void {
    this.effectsGain.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Sound map the resolver consults: merged (beatmap wins) when ON, skin-only when OFF. */
  private get _activeSounds(): Map<string, AudioBuffer> {
    return this._beatmapHitsounds ? this._mergedSounds : this._skinOnlySounds;
  }

  /**
   * Toggle "Beatmap Hitsounds" live. Flips which sound map backs every resolved sample;
   * the PendingSound schedule is identity-only, so nothing about it changes — only the
   * buffer the resolver picks. If playing, reschedule hitsounds from the current position
   * (song clock untouched) so the change is audible on the next hit instead of after the
   * ~2s look-ahead window rolls over.
   */
  setBeatmapHitsounds(on: boolean): void {
    if (on === this._beatmapHitsounds) return;
    this._beatmapHitsounds = on;
    if (!this._isPlaying) return;
    for (const src of this.activeHitsounds) {
      try { src.stop(); } catch (_) { /* already ended */ }
      src.disconnect();
    }
    this.activeHitsounds = [];
    if (this._flushTimer !== null) { clearInterval(this._flushTimer); this._flushTimer = null; }
    this._scheduleHitsounds(this.currentTimeMs);
  }

  /**
   * Snapshot the audio inputs for an offline mixdown (the offline twin of this live
   * scheduler). Volumes are read from the live gain nodes, so an offline render reflects
   * the current volume settings. Feed the result to the same pure schedule/resolve
   * functions in hitsoundSchedule.ts that live playback uses.
   */
  getMixdownInputs(): MixdownInputs {
    return {
      songBuffer: this.songBuffer,
      skinSounds: this._activeSounds,
      beatmapHitsounds: this._beatmapHitsounds,
      lazerDefaultSounds: this.lazerDefaultSounds,
      beatmap: this.beatmap,
      hitResults: this.hitResults,
      mode: this.mode,
      maniaSamples: this.maniaSamples,
      taikoGhostTaps: this.taikoGhostTaps,
      comboFrames: this.comboFrames,
      introOffsetMs: this.introOffsetMs,
      oldOffsetMs: this.oldOffsetMs,
      speed: this.speed,
      isNC: this._isNC,
      musicVol: this.songGain.gain.value,
      effectsVol: this.effectsGain.gain.value,
    };
  }

  get isPlaying(): boolean { return this._isPlaying; }

  /**
   * Current presentation time (ms). Plain linear clock for every mode: the song is an
   * AudioBufferSourceNode started at `_ctxTimeAtStart` and its buffer advances at a constant
   * rate, so presentation time is an exact linear function of the AudioContext hardware
   * clock — monotonic and smooth by construction, with no slewing or jitter absorption needed.
   */
  get currentTimeMs(): number {
    if (!this._isPlaying) return this._pausedPresTime;
    return this._presTimeAtStart + (this.ctx.currentTime - this._ctxTimeAtStart) * 1000 * this._userRate;
  }

  /**
   * Set the user playback rate (clamped to 0.1..2). Deliberately does NOT restart the song
   * (no async, no _playGen races — pattern-matches setSongVolume, not seekTo). If playing,
   * re-anchor first so the clock is continuous across the slope change; the still-playing
   * source briefly runs at the old rate while the clock ticks at the new one — callers
   * should immediately follow with a seek-in-place (seekTo to the current position), which
   * restarts everything through the standard gen-guarded path.
   */
  setUserRate(rate: number): void {
    const r = Math.max(0.1, Math.min(2, rate));
    if (r === this._userRate) return;
    if (this._isPlaying) {
      const pres = this.currentTimeMs; // read with OLD rate
      this._presTimeAtStart = pres;
      this._ctxTimeAtStart  = this.ctx.currentTime;
    }
    this._userRate = r;
  }

  /** Clock function suitable for `Player.setClockFn`, so the playback loop follows the audio clock. */
  get clockFn(): () => number {
    return () => this.currentTimeMs;
  }

  /** Start (or restart) playback from a presentation time (ms). Resumes the AudioContext if suspended. */
  async playFrom(presMs: number): Promise<void> {
    if (this._isPlaying) this._stopAll();
    const myGen = ++this._playGen;
    await this.ctx.resume();
    if (myGen !== this._playGen) return;

    this._presTimeAtStart = presMs;
    this._ctxTimeAtStart  = this.ctx.currentTime;
    this._isPlaying       = true;
    this._startSong(presMs);
    this._scheduleHitsounds(presMs);
  }

  pause(): void {
    // Bump unconditionally so a playFrom mid-resume (see _playGen) bails instead of starting.
    this._playGen++;
    if (this._isPlaying) this._pausedPresTime = this.currentTimeMs;
    this._stopAll();
    this._isPlaying = false;
  }

  async seekTo(presMs: number): Promise<void> {
    const wasPlaying = this._isPlaying;
    if (wasPlaying) {
      this._stopAll();
      this._isPlaying = false;
    }
    this._pausedPresTime = presMs;
    if (wasPlaying) await this.playFrom(presMs);
  }

  /** Stop everything and disconnect the gain nodes. Does NOT close the AudioContext — the caller owns it and may share it across sessions. */
  destroy(): void {
    this._stopAll();
    this.songGain.disconnect();
    this.effectsGain.disconnect();
  }

  private _startSong(presMs: number): void {
    if (this._playBuffer === null) return;
    const beatmapMs = presMs * this.speed + this.introOffsetMs;

    const source = this.ctx.createBufferSource();
    source.buffer = this._playBuffer;
    source.playbackRate.value = this._playRate * this._userRate;
    source.connect(this.songGain);

    if (beatmapMs < 0) {
      // Seek/lead-in predates the song start: delay the source (in real time) instead of
      // seeking. (−beatmapMs ms of beatmap time = −beatmapMs/(1000·speed·userRate) real seconds.)
      const delayS = -beatmapMs / (1000 * this.speed * this._userRate);
      source.start(this._ctxTimeAtStart + delayS, 0);
    } else {
      // Beatmap time → position in the play buffer. The raw buffer (nomod/NC) runs at
      // playbackRate = speed, so 1 buffer-second = 1 source-second → offset = beatmapMs/1000.
      // The pre-stretched DT/HT buffer runs at rate 1 and is already length/speed, so the same
      // beatmap time sits at beatmapMs/1000/speed. `_playRate / speed` unifies both (1 vs 1/speed).
      const offsetS = (beatmapMs / 1000) * (this._playRate / this.speed);
      source.start(this._ctxTimeAtStart, Math.min(offsetS, this._playBuffer.duration - 0.001));
    }

    this.activeSong = source;
  }

  // Build queue only; _flushPendingSounds creates nodes lazily within the horizon. The
  // sorted queue comes from the shared pure builder (computeHitsoundSchedule); this method
  // owns only the live flush/clock wiring. An offline mixdown calls the same builder and
  // schedules into an OfflineAudioContext instead.
  private _scheduleHitsounds(fromPresMs: number): void {
    const fromBeatmapMs = fromPresMs * this.speed + this.introOffsetMs;
    this._pendingSounds = computeHitsoundSchedule({
      mode: this.mode,
      beatmap: this.beatmap,
      hitResults: this.hitResults,
      maniaSamples: this.maniaSamples,
      taikoGhostTaps: this.taikoGhostTaps,
      comboFrames: this.comboFrames,
      oldOffsetMs: this.oldOffsetMs,
      fromBeatmapMs,
    });
    this._pendingSoundIdx = 0;
    this._sampleVoices = null;

    // Storyboard samples ride the same reschedule: find the first one at or after the new
    // position so a seek neither replays the past nor skips the future.
    this._sbSampleIdx = 0;
    while (
      this._sbSampleIdx < this._sbSamples.length
      && this._sbSamples[this._sbSampleIdx]!.time < fromBeatmapMs
    ) this._sbSampleIdx++;

    this._flushPendingSounds();
    if (this._pendingSoundIdx < this._pendingSounds.length
      || this._sbSampleIdx < this._sbSamples.length) {
      this._flushTimer = setInterval(() => this._flushPendingSounds(), FLUSH_INTERVAL_MS);
    }
  }

  private _flushPendingSounds(): void {
    if (!this._isPlaying) return;
    const now = this.ctx.currentTime;
    const horizon = now + FLUSH_HORIZON_S;

    // The song is a constant-rate buffer source anchored at start, so the beatmap↔ctx
    // mapping is fixed for the whole playback — anchor hitsounds to that same start
    // reference; no per-flush re-anchoring is needed.
    const anchorCtxS = this._ctxTimeAtStart;
    const anchorBeatmapMs = this._presTimeAtStart * this.speed + this.introOffsetMs;
    const toRealSec = 1000 * this.speed * this._userRate;

    while (this._pendingSoundIdx < this._pendingSounds.length) {
      const ev = this._pendingSounds[this._pendingSoundIdx]!;
      const when = anchorCtxS + (ev.beatmapMs - anchorBeatmapMs) / toRealSec;
      if (when > horizon) return;
      this._pendingSoundIdx++;
      // Chromium drops far-past sources rather than starting them immediately.
      const clampedWhen = when < now ? now : when;
      if (ev.type === 'combobreak') {
        this._scheduleCombobreak(clampedWhen);
      } else if (ev.type === 'spinnerbonus') {
        this._scheduleSpinnerBonus(clampedWhen, ev.volume ?? 1);
      } else {
        // OFF ignores the beatmap's custom file ref so resolution falls through to the
        // skin's set/type sample (osu!-faithful) instead of synth.
        const customFile = this._beatmapHitsounds ? ev.customFile : '';
        this._scheduleResolvedSound(ev.type, ev.sampleSet, ev.sampleIndex, customFile, clampedWhen, ev.volume ?? 1);
      }
    }
    // Storyboard samples share the anchor above, so they stay in step with the song through
    // seeks and rate changes without a clock of their own.
    while (this._sbSampleIdx < this._sbSamples.length) {
      const sample = this._sbSamples[this._sbSampleIdx]!;
      const when = anchorCtxS + (sample.time - anchorBeatmapMs) / toRealSec;
      if (when > horizon) break;
      this._sbSampleIdx++;
      this._scheduleStoryboardSample(sample, when < now ? now : when);
    }
    if (this._pendingSoundIdx < this._pendingSounds.length
      || this._sbSampleIdx < this._sbSamples.length) return;
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /**
   * One-shot storyboard sample. Volume is the event's 0–100 scaled into the effects bus, so
   * the host's effects slider still governs it.
   */
  private _scheduleStoryboardSample(sample: SbSample, when: number): void {
    const buf = this._sbSampleBuffers?.get(sample.lookupPath);
    // A storyboard may name a file the archive does not carry; nothing to play, and warning
    // per occurrence would spam a mirror-stripped set.
    if (buf === undefined) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const volume = Math.max(0, Math.min(1, sample.volume / 100));
    if (volume !== 1) {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(this.effectsGain);
    } else {
      src.connect(this.effectsGain);
    }
    src.start(when);
  }

  private _scheduleCombobreak(when: number): void {
    const buf = lookupSkinSound(this._activeSounds, 'combobreak');
    if (buf === null) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.effectsGain);
    src.start(when);
    this.activeHitsounds.push(src);
  }

  // Spinner bonus sample (one per bonus spin). Silent if the skin ships no spinnerbonus
  // file — same policy as combobreak (no default exists for it), no synth proxy.
  private _scheduleSpinnerBonus(when: number, volume: number): void {
    const buf = lookupSkinSound(this._activeSounds, 'spinnerbonus');
    if (buf === null) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (volume !== 1) {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(this.effectsGain);
    } else {
      src.connect(this.effectsGain);
    }
    src.start(when);
    this.activeHitsounds.push(src);
  }

  private _scheduleResolvedSound(
    type: 'normal' | 'whistle' | 'finish' | 'clap',
    sampleSet: number,
    sampleIndex: number,
    customFile: string,
    when: number,
    volume: number,
  ): void {
    const buf = resolveSample(type, sampleSet, sampleIndex, customFile, {
      mode: this.mode,
      skinSounds: this._activeSounds,
      lazerDefaultSounds: this.lazerDefaultSounds,
      synthCache: this.synthCache,
      ctx: this.ctx,
    });
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // Per-sample gain (mania volume). volume === 1 keeps the direct connection
    // std/taiko have always used, so those paths are byte-identical.
    if (volume !== 1) {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(this.effectsGain);
    } else {
      src.connect(this.effectsGain);
    }

    // Emulate BASS's per-sample concurrency cap (override longest-playing). Keyed
    // by resolved-sample identity, all modes — matches osu!'s shared audio path.
    {
      const key = `${type}|${sampleSet}|${sampleIndex}|${customFile}`;
      const voices = (this._sampleVoices ??= new Map());
      let list = voices.get(key);
      if (list === undefined) { list = []; voices.set(key, list); }
      // Drop voices that have finished before this one starts.
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.endWhen <= when) list.splice(i, 1);
      if (list.length >= SAMPLE_CONCURRENCY) {
        // Override the longest-playing voice (earliest start), cutting it at `when`.
        let minIdx = 0;
        for (let i = 1; i < list.length; i++) if (list[i]!.when < list[minIdx]!.when) minIdx = i;
        const victim = list[minIdx]!;
        try { victim.src.stop(when); } catch (_) { /* already ended */ }
        list.splice(minIdx, 1);
      }
      list.push({ when, endWhen: when + buf.duration, src });
    }

    src.start(when);
    this.activeHitsounds.push(src);
  }

  private _stopAll(): void {
    if (this.activeSong !== null) {
      try { this.activeSong.stop(); } catch (_) { /* already ended */ }
      this.activeSong.disconnect();
      this.activeSong = null;
    }
    for (const src of this.activeHitsounds) {
      try { src.stop(); } catch (_) { /* already ended */ }
      src.disconnect();
    }
    this.activeHitsounds = [];

    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._pendingSounds = [];
    this._pendingSoundIdx = 0;
    this._sampleVoices = null;
  }
}
