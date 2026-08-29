/**
 * Multi-replay match view & room modal (osu!lazer multiplayer match viewer).
 *
 * Implements room fetching, sub-top-bar map switching dropdown (lazer style),
 * N-canvas responsive grid layout, live standings leaderboard, full playback
 * hotkeys (Space, Arrow keys, Wheel with Volume & Seek HUDs), and in-playback settings drawer.
 */

import { icon } from '../results/icons.js';
import {
  fetchMatchRoom, parseRoomRef, playableCount,
  type MatchMap, type MatchRoom,
} from './matchRoom.js';
import { loadMatchMap } from './load.js';
import { createMatch, type MatchHandle, type MatchStanding } from './match.js';
import { loadSkin, DEFAULT_SKIN } from './skins.js';
import {
  buildVolumeMeter, KeyAccelerator, type VolumeMeterHandle,
} from './volume-meter.js';
import {
  buildSettingsOverlay, type SettingsOverlayHandle, type SettingsSection, type SliderHandle,
} from './settings.js';
import { uiSounds, VOL_KEYS, readStoredVolume, writeStoredVolume } from './uiSounds.js';
import { t, isZh } from './i18n.js';

export interface MatchViewOptions {
  readonly host: HTMLElement;
  readonly getAudioContext: () => AudioContext;
  readonly getSkin: () => string;
  readonly log: (msg: string) => void;
  readonly onExit: () => void;
}

export interface MatchViewHandle {
  readonly root: HTMLElement;
  openRoomDialog(): void;
  loadAndPlayMap(map: MatchMap): Promise<void>;
  toggleSettings(): void;
  destroy(): void;
}

export function buildMatchView(options: MatchViewOptions): MatchViewHandle {
  const root = document.createElement('div');
  root.className = 'rv-match-screen';
  root.hidden = true;

  // ---- Header / Sub-top-bar (二级顶栏) ----
  const header = document.createElement('div');
  header.className = 'rv-match-header';

  const leftGroup = document.createElement('div');
  leftGroup.className = 'rv-match-header-left';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'rv-match-btn rv-match-back-btn';
  backBtn.append(icon('rewind', { className: 'rv-icon' }));
  backBtn.append(document.createTextNode(t('退出比赛', 'Exit Match')));
  uiSounds.attachHoverClick(backBtn, { hover: 'button', click: false });
  backBtn.addEventListener('click', () => {
    uiSounds.playClick('button');
    stopCurrentMatch();
    root.hidden = true;
    root.remove();
    options.onExit();
  });

  const titleInfo = document.createElement('div');
  titleInfo.className = 'rv-match-title-info';

  const mapTitle = document.createElement('div');
  mapTitle.className = 'rv-match-map-title';
  mapTitle.textContent = 'Multiplayer Match';

  const mapSub = document.createElement('div');
  mapSub.className = 'rv-match-map-sub';
  mapSub.textContent = '';

  titleInfo.append(mapTitle, mapSub);
  leftGroup.append(backBtn, titleInfo);

  // Right side of header: Map Switcher dropdown button + Settings button
  const rightGroup = document.createElement('div');
  rightGroup.className = 'rv-match-header-right';

  const mapSelectBtn = document.createElement('button');
  mapSelectBtn.type = 'button';
  mapSelectBtn.className = 'rv-match-btn rv-match-map-select-btn';
  const mapSelectLabel = document.createElement('span');
  mapSelectLabel.className = 'rv-match-map-select-label';
  mapSelectLabel.textContent = t('对局列表', 'Match Maps');
  mapSelectBtn.append(icon('mode-match', { className: 'rv-icon' }), mapSelectLabel, icon('chevron-right', { className: 'rv-icon rv-rotate-90' }));
  uiSounds.attachHoverClick(mapSelectBtn, { hover: 'button', click: false });

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'rv-match-btn rv-match-settings-btn';
  settingsBtn.title = t('回放设置面板', 'Replay Settings');
  settingsBtn.append(icon('settings', { className: 'rv-icon' }), document.createTextNode(t('设置', 'Settings')));
  settingsBtn.style.display = 'none';
  uiSounds.attachHoverClick(settingsBtn, { hover: 'button', click: false });
  settingsBtn.addEventListener('click', () => {
    uiSounds.playClick('button');
    toggleSettings();
  });

  rightGroup.append(mapSelectBtn, settingsBtn);
  header.append(leftGroup, rightGroup);

  // Main stage containing the multi-canvas grid
  const gridStage = document.createElement('div');
  gridStage.className = 'rv-match-grid-stage';

  // Edge hint for right-hand settings drawer
  const edgeHint = document.createElement('div');
  edgeHint.className = 'rv-edge-hint';

  // Floating Standings / Leaderboard overlay
  const standingsEl = document.createElement('div');
  standingsEl.className = 'rv-match-standings';

  const standingsHeader = document.createElement('div');
  standingsHeader.className = 'rv-match-standings-header';
  standingsHeader.textContent = t('实时排名', 'Live Leaderboard');

  const standingsList = document.createElement('div');
  standingsList.className = 'rv-match-standings-list';

  standingsEl.append(standingsHeader, standingsList);

  // Transport controls bar at bottom
  const transport = document.createElement('div');
  transport.className = 'rv-match-transport';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'rv-match-transport-btn';
  playBtn.append(icon('play', { className: 'rv-icon' }));
  uiSounds.attachHoverClick(playBtn, { hover: 'button', click: false });

  const timeDisplay = document.createElement('span');
  timeDisplay.className = 'rv-match-time';
  timeDisplay.textContent = '0:00 / 0:00';

  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.className = 'rv-match-scrubber';
  scrubber.min = '0';
  scrubber.max = '100';
  scrubber.value = '0';

  transport.append(playBtn, timeDisplay, scrubber);

  // Container for active match playback (grid, standings, transport, header)
  const playbackScreen = document.createElement('div');
  playbackScreen.className = 'rv-match-playback-screen';
  playbackScreen.hidden = true;
  playbackScreen.append(header, gridStage, edgeHint, standingsEl, transport);

  // In-page setup wizard screen (renders directly in page replacing sub-header & playback area)
  const setupScreen = document.createElement('div');
  setupScreen.className = 'rv-match-setup-screen';

  root.append(playbackScreen, setupScreen);

  let activeMatch: MatchHandle | null = null;
  let activeMap: MatchMap | null = null;
  let currentRoom: MatchRoom | null = null;
  let standingsTimer: number | null = null;
  let isPlaying = false;

  let activeDropdownMenu: HTMLElement | null = null;
  let overlay: SettingsOverlayHandle | null = null;
  let volumeMeter: VolumeMeterHandle | null = null;

  let songVol = readStoredVolume(VOL_KEYS.music, 0.25);
  let fxVol = readStoredVolume(VOL_KEYS.effects, 0.25);

  const closeMapDropdown = (): void => {
    if (activeDropdownMenu !== null) {
      activeDropdownMenu.remove();
      activeDropdownMenu = null;
      mapSelectBtn.classList.remove('rv-btn-active');
    }
  };

  document.addEventListener('pointerdown', (e: PointerEvent) => {
    if (activeDropdownMenu !== null && !activeDropdownMenu.contains(e.target as Node) && !mapSelectBtn.contains(e.target as Node)) {
      uiSounds.playDropdown(false);
      closeMapDropdown();
    }
  });

  const toggleMapDropdown = (): void => {
    if (activeDropdownMenu !== null) {
      uiSounds.playDropdown(false);
      closeMapDropdown();
      return;
    }
    if (currentRoom === null || currentRoom.maps.length === 0) {
      openRoomDialog();
      return;
    }

    uiSounds.playDropdown(true);
    mapSelectBtn.classList.add('rv-btn-active');
    const menuEl = document.createElement('div');
    menuEl.className = 'rv-dropdown-menu rv-match-dropdown depth-1';

    const container = document.createElement('div');
    container.className = 'rv-menu-scroll-container';
    menuEl.append(container);

    currentRoom.maps.forEach((m, idx) => {
      const avail = playableCount(m);
      const isCurrent = activeMap !== null && activeMap.playlistItemId === m.playlistItemId;

      const row = document.createElement('div');
      row.className = 'rv-menu-row';
      if (avail === 0) {
        row.classList.add('rv-row-disabled');
        row.title = t('该谱面无可用回放', 'No replays available');
      }

      row.addEventListener('pointerenter', () => uiSounds.playHover('default'));

      const labelWrapper = document.createElement('span');
      labelWrapper.className = 'rv-menu-row-label';

      if (isCurrent) {
        const check = document.createElement('span');
        check.className = 'rv-menu-check';
        check.append(icon('check', { className: 'rv-icon' }));
        labelWrapper.append(check);
      }

      const textSpan = document.createElement('span');
      textSpan.textContent = `#${idx + 1} ${m.artist} - ${m.title} [${m.version}]`;
      labelWrapper.append(textSpan);
      row.append(labelWrapper);

      const badge = document.createElement('span');
      badge.className = 'rv-menu-badge';
      badge.textContent = `${avail}/${m.scores.length}`;
      row.append(badge);

      if (avail > 0) {
        row.addEventListener('click', (e: MouseEvent) => {
          e.stopPropagation();
          uiSounds.playClick('button');
          closeMapDropdown();
          if (!isCurrent) {
            void loadAndPlayMap(m).catch(err => {
              console.error(err);
              options.log(`Match load failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        });
      } else {
        row.addEventListener('click', (e: MouseEvent) => {
          e.stopPropagation();
          uiSounds.playClick('disabled');
        });
      }

      container.append(row);
    });

    const divider = document.createElement('div');
    divider.className = 'rv-menu-divider';
    container.append(divider);

    const switchRow = document.createElement('div');
    switchRow.className = 'rv-menu-row';
    switchRow.addEventListener('pointerenter', () => uiSounds.playHover('default'));
    const switchLabel = document.createElement('span');
    switchLabel.className = 'rv-menu-row-label';
    switchLabel.append(icon('mode-match', { className: 'rv-icon rv-menu-item-icon' }), document.createTextNode(t('输入其他比赛房间…', 'Switch Match Room…')));
    switchRow.append(switchLabel);
    switchRow.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      uiSounds.playClick('default');
      closeMapDropdown();
      openRoomDialog();
    });
    container.append(switchRow);

    menuEl.style.top = `${mapSelectBtn.offsetTop + mapSelectBtn.offsetHeight + 4}px`;
    menuEl.style.right = `${header.offsetWidth - (mapSelectBtn.offsetLeft + mapSelectBtn.offsetWidth)}px`;
    menuEl.style.left = 'auto';
    header.append(menuEl);
    activeDropdownMenu = menuEl;
  };

  mapSelectBtn.addEventListener('click', toggleMapDropdown);

  const formatMinSec = (ms: number): string => {
    const secTotal = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(secTotal / 60);
    const s = secTotal % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const updateStandingsUi = (standings: readonly MatchStanding[]): void => {
    standingsList.replaceChildren();
    for (const s of standings) {
      const row = document.createElement('div');
      row.className = 'rv-standings-row';
      if (s.team) row.classList.add(`rv-team-${s.team}`);

      const pos = document.createElement('span');
      pos.className = 'rv-standings-pos';
      pos.textContent = `#${s.position}`;

      const name = document.createElement('span');
      name.className = 'rv-standings-name';
      name.textContent = s.name;

      const score = document.createElement('span');
      score.className = 'rv-standings-score';
      score.textContent = s.score.toLocaleString();

      const acc = document.createElement('span');
      acc.className = 'rv-standings-acc';
      acc.textContent = `${(s.accuracy * 100).toFixed(2)}%`;

      const combo = document.createElement('span');
      combo.className = 'rv-standings-combo';
      combo.textContent = `${s.combo}x`;

      row.append(pos, name, score, acc, combo);
      standingsList.append(row);
    }
  };

  // ---- Volume & Settings Helpers ----
  const applySongVolume = (vol: number) => {
    songVol = Math.max(0, Math.min(1, Math.round(vol * 100) / 100));
    writeStoredVolume(VOL_KEYS.music, songVol);
    if (activeMatch !== null) {
      activeMatch.audible.session.audioSync.setSongVolume(songVol);
    }
  };

  const applyEffectsVolume = (vol: number) => {
    fxVol = Math.max(0, Math.min(1, Math.round(vol * 100) / 100));
    writeStoredVolume(VOL_KEYS.effects, fxVol);
    if (activeMatch !== null) {
      for (const slot of activeMatch.slots) {
        slot.session.audioSync.setEffectsVolume(fxVol);
      }
    }
  };

  const adjustBothVolumes = (delta: number) => {
    const nextSong = Math.max(0, Math.min(1, Math.round((songVol + delta) * 100) / 100));
    const nextFx = Math.max(0, Math.min(1, Math.round((fxVol + delta) * 100) / 100));
    applySongVolume(nextSong);
    applyEffectsVolume(nextFx);
    volumeMeter?.showVolumes(nextSong, nextFx);
  };

  const adjustSongOnly = (delta: number) => {
    const next = Math.max(0, Math.min(1, Math.round((songVol + delta) * 100) / 100));
    applySongVolume(next);
    volumeMeter?.showMusicVolume(next);
  };

  const adjustEffectsOnly = (delta: number) => {
    const next = Math.max(0, Math.min(1, Math.round((fxVol + delta) * 100) / 100));
    applyEffectsVolume(next);
    volumeMeter?.showEffectsVolume(next);
  };

  const stopCurrentMatch = (): void => {
    if (standingsTimer !== null) {
      clearInterval(standingsTimer);
      standingsTimer = null;
    }
    overlay?.destroy();
    overlay = null;
    volumeMeter?.destroy();
    volumeMeter = null;
    closeMapDropdown();

    if (activeMatch !== null) {
      activeMatch.destroy();
      activeMatch = null;
    }
    activeMap = null;
    gridStage.replaceChildren();
    isPlaying = false;
    settingsBtn.style.display = 'none';
  };

  const playPauseToggle = (): void => {
    if (activeMatch === null) return;
    if (isPlaying) {
      activeMatch.pause();
      isPlaying = false;
      playBtn.replaceChildren(icon('play', { className: 'rv-icon' }));
    } else {
      void activeMatch.play(activeMatch.audible.session.audioSync.currentTimeMs).then(() => {
        isPlaying = true;
        playBtn.replaceChildren(icon('pause', { className: 'rv-icon' }));
      });
    }
  };

  playBtn.addEventListener('click', playPauseToggle);

  scrubber.addEventListener('input', () => {
    if (activeMatch === null) return;
    const fraction = parseFloat(scrubber.value) / 100;
    const targetMs = fraction * activeMatch.durationMs;
    void activeMatch.seek(targetMs);
    timeDisplay.textContent = `${formatMinSec(targetMs)} / ${formatMinSec(activeMatch.durationMs)}`;
  });

  // ---- Keydown & Wheel Hotkeys ----
  const volumeAccelerator = new KeyAccelerator(0.01, 8, 300);
  const seekAccelerator = new KeyAccelerator(1000, 10, 320);

  const onKeyDown = (e: KeyboardEvent) => {
    if (root.hidden || activeMatch === null) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      playPauseToggle();
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      const delta = volumeAccelerator.getDelta();
      adjustBothVolumes(delta);
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      const delta = volumeAccelerator.getDelta();
      adjustBothVolumes(-delta);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      const delta = seekAccelerator.getDelta();
      const curMs = activeMatch.audible.session.audioSync.currentTimeMs;
      const targetMs = Math.max(0, curMs - delta);
      void activeMatch.seek(targetMs);
      volumeMeter?.showSeek(targetMs, -delta, activeMatch.durationMs);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      const delta = seekAccelerator.getDelta();
      const curMs = activeMatch.audible.session.audioSync.currentTimeMs;
      const dur = activeMatch.durationMs;
      const targetMs = Math.min(dur, curMs + delta);
      void activeMatch.seek(targetMs);
      volumeMeter?.showSeek(targetMs, delta, dur);
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const onWheel = (e: WheelEvent) => {
    if (root.hidden || activeMatch === null) return;
    if (overlay?.root.contains(e.target as Node)) return;
    if (volumeMeter?.root.contains(e.target as Node)) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.02 : -0.02;
    adjustBothVolumes(delta);
  };
  root.addEventListener('wheel', onWheel, { passive: false });

  // ---- Settings Overlay Builder for Match Mode ----
  const buildMatchSettings = (match: MatchHandle): SettingsSection[] => {
    const parsePercent = (raw: string): number | null => {
      const cleaned = raw.trim().replace(/%/g, '');
      if (cleaned === '') return null;
      const num = parseFloat(cleaned);
      if (Number.isNaN(num)) return null;
      return Math.max(0, Math.min(100, Math.ceil(num))) / 100;
    };

    let musicHandle: SliderHandle | null = null;
    let effectsHandle: SliderHandle | null = null;
    let isLinked = false;

    const playbackSec: SettingsSection = {
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
            match.audible.session.audioSync.setUserRate(v);
            void match.seek(match.audible.session.audioSync.currentTimeMs);
          },
        },
      ],
    };

    const firstOpts = match.slots[0]!.session.renderer.options;
    const displaySec: SettingsSection = {
      title: t('画面', 'Display'),
      controls: [
        {
          kind: 'slider',
          label: t('背景暗化', 'Background dim'),
          min: 0, max: 1, step: 0.01, value: firstOpts.backgroundDim,
          format: v => `${Math.round(v * 100)}%`,
          resetTo: 0.8,
          parseInput: parsePercent,
          getEditText: v => String(Math.round(v * 100)),
          onChange: v => {
            for (const s of match.slots) s.session.renderer.options.backgroundDim = v;
          },
        },
        {
          kind: 'toggle', label: t('故事版', 'Storyboard'), value: firstOpts.showStoryboard, resetTo: true,
          onChange: v => { for (const s of match.slots) s.session.renderer.options.showStoryboard = v; },
        },
        {
          kind: 'toggle', label: t('按键显示', 'Key overlay'), value: firstOpts.showKeyOverlay, resetTo: true,
          onChange: v => { for (const s of match.slots) s.session.renderer.options.showKeyOverlay = v; },
        },
        {
          kind: 'toggle', label: t('判定显示', 'Judgements'), value: firstOpts.showJudgement, resetTo: true,
          onChange: v => { for (const s of match.slots) s.session.renderer.options.showJudgement = v; },
        },
        {
          kind: 'toggle', label: t('UR 误差条', 'Unstable rate bar'), value: firstOpts.showURBar, resetTo: true,
          onChange: v => { for (const s of match.slots) s.session.renderer.options.showURBar = v; },
        },
        {
          kind: 'toggle', label: t('跟随时条', 'Follow points'), value: firstOpts.showFollowpoints, resetTo: true,
          onChange: v => { for (const s of match.slots) s.session.renderer.options.showFollowpoints = v; },
        },
        {
          kind: 'toggle', label: t('Mod 图标', 'Mod icons'), value: firstOpts.showModIcons, resetTo: true,
          onChange: v => { for (const s of match.slots) s.session.renderer.options.showModIcons = v; },
        },
      ],
    };

    const audioSec: SettingsSection = {
      title: t('音频', 'Audio'),
      controls: [
        {
          kind: 'slider',
          label: t('音乐音量', 'Music volume'),
          min: 0, max: 1, step: 0.01, value: songVol,
          format: v => `${Math.round(v * 100)}%`,
          resetTo: 0.25,
          parseInput: parsePercent,
          getEditText: v => String(Math.round(v * 100)),
          bindHandle: h => { musicHandle = h; },
          onChange: v => {
            applySongVolume(v);
            if (isLinked && effectsHandle) {
              applyEffectsVolume(v);
              effectsHandle.setValue(v, false);
              volumeMeter?.showVolumes(v, v);
            } else {
              volumeMeter?.showMusicVolume(v);
            }
          },
        },
        {
          kind: 'custom',
          render: () => {
            const div = document.createElement('div');
            div.className = 'ps-volume-link-divider';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ps-volume-link-btn';
            btn.append(icon('link', { className: 'rv-icon' }));
            btn.addEventListener('click', () => {
              isLinked = !isLinked;
              btn.classList.toggle('ps-linked', isLinked);
              if (isLinked && musicHandle && effectsHandle) {
                const minVal = Math.min(musicHandle.getValue(), effectsHandle.getValue());
                applySongVolume(minVal);
                applyEffectsVolume(minVal);
                musicHandle.setValue(minVal, true);
                effectsHandle.setValue(minVal, true);
              }
            });
            div.append(btn);
            return div;
          },
        },
        {
          kind: 'slider',
          label: t('音效音量', 'Effects volume'),
          min: 0, max: 1, step: 0.01, value: fxVol,
          format: v => `${Math.round(v * 100)}%`,
          resetTo: 0.25,
          parseInput: parsePercent,
          getEditText: v => String(Math.round(v * 100)),
          bindHandle: h => { effectsHandle = h; },
          onChange: v => {
            applyEffectsVolume(v);
            if (isLinked && musicHandle) {
              applySongVolume(v);
              musicHandle.setValue(v, false);
              volumeMeter?.showVolumes(v, v);
            } else {
              volumeMeter?.showEffectsVolume(v);
            }
          },
        },
        {
          kind: 'slider',
          label: t('音频偏移', 'Audio offset'),
          min: -200, max: 200, step: 1, value: firstOpts.audioOffsetMs,
          format: v => `${v > 0 ? '+' : ''}${v} ms`,
          resetTo: 0,
          parseInput: raw => {
            const n = parseInt(raw.trim().replace(/ms/gi, ''), 10);
            return Number.isNaN(n) ? null : Math.max(-200, Math.min(200, n));
          },
          getEditText: v => String(v),
          onChange: v => {
            for (const s of match.slots) s.session.renderer.options.audioOffsetMs = v;
          },
        },
        {
          kind: 'slider',
          label: t('界面音效音量', 'UI sound volume'),
          min: 0, max: 1, step: 0.01, value: uiSounds.getVolume(),
          format: v => `${Math.round(v * 100)}%`,
          resetTo: 0.25,
          parseInput: parsePercent,
          getEditText: v => String(Math.round(v * 100)),
          onChange: v => { uiSounds.setVolume(v); },
        },
      ],
    };

    return [playbackSec, displaySec, audioSec];
  };

  const toggleSettings = (): void => {
    if (overlay !== null) {
      if (overlay.visible) overlay.hide();
      else overlay.show();
    }
  };

  // ---- Map Loader & Grid Orchestrator ----
  const loadAndPlayMap = async (map: MatchMap): Promise<void> => {
    root.hidden = false;
    if (!options.host.contains(root)) options.host.append(root);
    setupScreen.hidden = true;
    playbackScreen.hidden = false;
    stopCurrentMatch();
    activeMap = map;
    options.log(`Loading match map: ${map.title} [${map.version}]…`);

    mapTitle.textContent = `${map.artist} - ${map.title}`;
    mapSub.textContent = `[${map.version}] • ${currentRoom?.name ?? 'Multiplayer Match'}`;
    mapSelectLabel.textContent = `${map.title} [${map.version}]`;

    const { beatmapSet, players } = await loadMatchMap(map, options.log);
    if (players.length === 0) {
      throw new Error('No playable replays found for this map');
    }

    const audioCtx = options.getAudioContext();
    const skinName = options.getSkin() || DEFAULT_SKIN;
    const skin = await loadSkin(skinName, audioCtx);

    // Create N 1280x720 canvases
    const canvases = players.map(() => {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      c.className = 'rv-match-canvas';
      return c;
    });

    // Configure Grid layout classes based on player count
    const count = players.length;
    gridStage.className = `rv-match-grid-stage rv-grid-${Math.min(8, Math.max(1, count))}`;

    players.forEach((p, idx) => {
      const slotCard = document.createElement('div');
      slotCard.className = 'rv-match-slot';
      if (p.team) slotCard.classList.add(`rv-team-border-${p.team}`);

      const badge = document.createElement('div');
      badge.className = 'rv-match-slot-badge';
      if (p.team) badge.classList.add(`rv-team-bg-${p.team}`);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'rv-match-slot-name';
      nameSpan.textContent = p.name;

      badge.append(nameSpan);
      slotCard.append(canvases[idx]!, badge);
      gridStage.append(slotCard);
    });

    root.hidden = false;

    const match = await createMatch({
      beatmapSet,
      audioContext: audioCtx,
      skin,
      lazerDefaultsUrl: '/assets/lazer-defaults',
      players: players.map((p, i) => ({ ...p, canvas: canvases[i]! })),
      audibleIndex: 0,
      log: options.log,
    });

    activeMatch = match;
    applySongVolume(songVol);
    applyEffectsVolume(fxVol);
    isPlaying = true;
    playBtn.replaceChildren(icon('pause', { className: 'rv-icon' }));

    // Wire Volume Meter
    volumeMeter = buildVolumeMeter({
      onAdjustMusic: delta => adjustSongOnly(delta),
      onAdjustEffects: delta => adjustEffectsOnly(delta),
    });
    root.append(volumeMeter.root);

    // Wire Settings Drawer
    const sections = buildMatchSettings(match);
    overlay = buildSettingsOverlay(sections, root);
    root.append(overlay.root);

    root.addEventListener('pointermove', () => {
      if (overlay?.visible === true) edgeHint.style.opacity = '0';
    });

    await match.play(0);

    // Live standing update loop (~4 times/sec)
    standingsTimer = window.setInterval(() => {
      if (activeMatch === null) return;
      const curMs = activeMatch.audible.session.audioSync.currentTimeMs;
      const durMs = activeMatch.durationMs;
      timeDisplay.textContent = `${formatMinSec(curMs)} / ${formatMinSec(durMs)}`;
      if (durMs > 0) {
        scrubber.value = String((curMs / durMs) * 100);
      }
      updateStandingsUi(activeMatch.standings());
    }, 250);

    settingsBtn.style.display = 'inline-flex';
    options.log('Match playing!');
  };

  // ---- 1. Setup Wizard Screen Elements (osu!lazer Screen / Wizard style from Image 2) ----
  const setupContent = document.createElement('div');
  setupContent.className = 'rv-match-setup-content';

  // 1. Top Hanging Header Banner Card ("多人房间回放")
  const setupHeader = document.createElement('header');
  setupHeader.className = 'rv-match-dialog-header';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'rv-match-dialog-header-left';

  const headerText = document.createElement('div');
  headerText.className = 'rv-match-dialog-header-text';

  const setupTitle = document.createElement('h2');
  setupTitle.className = 'rv-match-dialog-title';
  setupTitle.textContent = t('多人房间回放', 'Multiplayer Match Room');

  const setupSubtitle = document.createElement('p');
  setupSubtitle.className = 'rv-match-dialog-subtitle';
  setupSubtitle.textContent = t('和全世界的玩家一起重温精彩对决！', 'Relive multiplayer match showdowns with players worldwide!');

  headerText.append(setupTitle, setupSubtitle);
  headerLeft.append(headerText);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rv-match-dialog-close-btn';
  closeBtn.setAttribute('aria-label', t('关闭', 'Close'));
  closeBtn.append(icon('close', { className: 'rv-icon' }));
  uiSounds.attachHoverClick(closeBtn, { hover: 'button', click: false });
  closeBtn.addEventListener('click', () => {
    uiSounds.playClick('dialog-cancel');
    options.onExit();
  });

  setupHeader.append(headerLeft, closeBtn);

  // 2. Main Setup Content Card ("房间设定")
  const setupBody = document.createElement('div');
  setupBody.className = 'rv-match-dialog-body';

  const sectionHeading = document.createElement('div');
  sectionHeading.className = 'rv-match-section-heading';
  const sectionTitle = document.createElement('h3');
  sectionTitle.className = 'rv-match-section-title';
  sectionTitle.textContent = t('房间设定', 'Match Setup');
  sectionHeading.append(sectionTitle);

  const inputGroup = document.createElement('div');
  inputGroup.className = 'rv-match-input-group';

  const inputLabel = document.createElement('label');
  inputLabel.className = 'rv-match-input-label';
  inputLabel.htmlFor = 'rv-match-room-input';
  inputLabel.textContent = t('比赛链接或房间 ID', 'Match URL or Room ID');

  const inputWrap = document.createElement('div');
  inputWrap.className = 'rv-match-input-wrap';

  const inputIcon = icon('link', { className: 'rv-icon rv-match-input-icon' });
  const roomInput = document.createElement('input');
  roomInput.id = 'rv-match-room-input';
  roomInput.type = 'text';
  roomInput.className = 'rv-match-input-field';
  roomInput.placeholder = t('输入比赛链接（如 https://osu.ppy.sh/community/matches/114979109）或纯数字房间 ID', 'https://osu.ppy.sh/community/matches/114979109 or 114979109');
  uiSounds.attachHoverClick(roomInput, { hover: 'default', click: false });

  inputWrap.append(inputIcon, roomInput);
  inputGroup.append(inputLabel, inputWrap);

  const statusMsg = document.createElement('div');
  statusMsg.className = 'rv-match-dialog-status';

  const notice = document.createElement('div');
  notice.className = 'rv-match-notice';
  const noticeText = document.createElement('span');
  noticeText.className = 'rv-match-notice-text';
  if (isZh()) {
    noticeText.innerHTML = `<strong class="rv-match-notice-accent">注意：</strong>多人房间回放依赖 <strong class="rv-match-highlight">osu! API</strong> 获取公开对战记录。未登录状态下可解析房间并浏览谱面列表，<strong class="rv-match-highlight">登录 osu! 账号</strong>后可自动下载并播放所有玩家的回放。`;
  } else {
    noticeText.innerHTML = `<strong class="rv-match-notice-accent">Note:</strong> Multiplayer match replay relies on <strong class="rv-match-highlight">osu! API</strong> for public records. You can browse map lists without login, and <strong class="rv-match-highlight">sign in to osu!</strong> to download and play all participant replays.`;
  }
  notice.append(noticeText);

  setupBody.append(sectionHeading, inputGroup, statusMsg, notice);
  setupContent.append(setupHeader, setupBody);

  // 3. Bottom Full-Width Action Footer Bar (Lazer slanted parallelogram style)
  const setupFooter = document.createElement('footer');
  setupFooter.className = 'rv-match-dialog-footer-bar';

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'rv-match-footer-actions';

  const backSetupBtn = document.createElement('button');
  backSetupBtn.type = 'button';
  backSetupBtn.className = 'rv-match-btn-back-lazer';
  const backSkew = document.createElement('span');
  backSkew.className = 'rv-match-btn-skew-content';
  const backIcon = icon('chevron-left', { className: 'rv-icon rv-match-back-chevron' });
  const backText = document.createElement('span');
  backText.textContent = t('返回', 'Back');
  backSkew.append(backIcon, backText);
  backSetupBtn.append(backSkew);
  uiSounds.attachHoverClick(backSetupBtn, { hover: 'button', click: false });
  backSetupBtn.addEventListener('click', () => {
    uiSounds.playClick('dialog-cancel');
    options.onExit();
  });

  const fetchBtn = document.createElement('button');
  fetchBtn.type = 'button';
  fetchBtn.className = 'rv-match-btn-submit-lazer';
  const fetchSkew = document.createElement('span');
  fetchSkew.className = 'rv-match-btn-skew-content';
  const fetchText = document.createElement('span');
  fetchText.textContent = t('获取比赛房间！', 'Fetch Match Room!');
  fetchSkew.append(fetchText);
  fetchBtn.append(fetchSkew);
  uiSounds.attachHoverClick(fetchBtn, { hover: 'button', click: false });

  actionsWrap.append(backSetupBtn, fetchBtn);
  setupFooter.append(actionsWrap);
  setupScreen.append(setupContent, setupFooter);

  const onFetch = async (): Promise<void> => {
    const val = roomInput.value.trim();
    const roomId = parseRoomRef(val);
    if (roomId === null) {
      uiSounds.playError();
      statusMsg.textContent = t('请输入有效的比赛链接或纯数字房间 ID', 'Please enter a valid match URL or numeric room ID');
      statusMsg.className = 'rv-match-dialog-status rv-status-error';
      roomInput.focus();
      return;
    }

    uiSounds.playClick('dialog-ok');
    statusMsg.textContent = t('正在获取比赛房间信息…', 'Fetching match room data…');
    statusMsg.className = 'rv-match-dialog-status rv-status-loading';
    fetchBtn.disabled = true;

    try {
      const room = await fetchMatchRoom(roomId);
      currentRoom = room;

      // Find first playable map and play it immediately, while setting up the top sub-bar dropdown
      const firstPlayable = room.maps.find(m => playableCount(m) > 0);
      if (firstPlayable) {
        void loadAndPlayMap(firstPlayable);
      } else if (room.maps.length > 0) {
        void loadAndPlayMap(room.maps[0]!);
      } else {
        options.log(`Room "${room.name}" has no maps.`);
      }
    } catch (err) {
      fetchBtn.disabled = false;
      uiSounds.playError();
      statusMsg.textContent = `${t('获取失败: ', 'Failed to fetch: ')}${err instanceof Error ? err.message : String(err)}`;
      statusMsg.className = 'rv-match-dialog-status rv-status-error';
    }
  };

  fetchBtn.addEventListener('click', () => void onFetch());
  roomInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') void onFetch();
    if (e.key === 'Escape') {
      uiSounds.playClick('dialog-cancel');
      options.onExit();
    }
  });

  const showSetupScreen = (): void => {
    root.hidden = false;
    if (!options.host.contains(root)) options.host.append(root);
    stopCurrentMatch();
    playbackScreen.hidden = true;
    setupScreen.hidden = false;
    statusMsg.textContent = '';
    statusMsg.className = 'rv-match-dialog-status';
    fetchBtn.disabled = false;
    uiSounds.playDialog('pop-in');
    setTimeout(() => roomInput.focus(), 60);
  };

  const openRoomDialog = (): void => {
    showSetupScreen();
  };

  return {
    root,
    openRoomDialog,
    loadAndPlayMap,
    toggleSettings,
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('wheel', onWheel);
      stopCurrentMatch();
      root.hidden = true;
      root.remove();
    },
  };
}

export function matchViewCss(): string {
  return `
/* Match screen layout & styling */
.rv-match-screen {
  position: absolute;
  inset: 0;
  background: #101018;
  display: flex;
  flex-direction: column;
  z-index: 10;
  user-select: none;
  overflow: hidden;
}

.rv-match-screen[hidden] {
  display: none !important;
}

.rv-match-header {
  flex: 0 0 44px;
  height: 44px;
  background: #1c2624;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 16px;
  position: relative;
  z-index: 30;
}

.rv-match-header-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}
.rv-match-header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.rv-match-btn {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  color: #e0ecea;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 120ms ease;
  white-space: nowrap;
}
.rv-match-btn:hover,
.rv-match-btn.rv-btn-active {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
  border-color: rgba(78, 217, 200, 0.4);
}

.rv-match-map-select-label {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rv-rotate-90 {
  transform: rotate(90deg);
}

.rv-match-dropdown {
  min-width: 320px;
  max-width: 480px;
}

.rv-match-title-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.rv-match-map-title {
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rv-match-map-sub {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Multi-canvas grid stage */
.rv-match-grid-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  gap: 6px;
  padding: 8px;
  box-sizing: border-box;
  background: #09090e;
  position: relative;
}

/* Grid configurations (1-8 players) */
.rv-grid-1 { grid-template-columns: 1fr; grid-template-rows: 1fr; }
.rv-grid-2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
.rv-grid-3, .rv-grid-4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.rv-grid-5, .rv-grid-6 { grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr; }
.rv-grid-7, .rv-grid-8 { grid-template-columns: 1fr 1fr 1fr 1fr; grid-template-rows: 1fr 1fr; }

.rv-match-slot {
  position: relative;
  background: #000000;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rv-match-canvas {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.rv-team-border-red { outline: 2px solid #ff4466; }
.rv-team-border-blue { outline: 2px solid #3399ff; }

.rv-match-slot-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  color: #ffffff;
  pointer-events: none;
  z-index: 5;
}
.rv-team-bg-red { background: rgba(230, 40, 70, 0.85); }
.rv-team-bg-blue { background: rgba(40, 130, 240, 0.85); }

/* Live Standings Leaderboard */
.rv-match-standings {
  position: absolute;
  top: 54px;
  right: 16px;
  width: 260px;
  max-height: 280px;
  background: rgba(20, 20, 28, 0.85);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
  z-index: 15;
}
.rv-match-standings-header {
  font-size: 11.5px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.65);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 4px;
}
.rv-match-standings-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}
.rv-standings-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #ffffff;
  padding: 2px 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
}
.rv-standings-row.rv-team-red { border-left: 3px solid #ff4466; }
.rv-standings-row.rv-team-blue { border-left: 3px solid #3399ff; }
.rv-standings-pos { font-weight: 800; color: #ffcc22; min-width: 20px; }
.rv-standings-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.rv-standings-score { font-variant-numeric: tabular-nums; font-weight: 700; }
.rv-standings-acc { font-size: 11px; opacity: 0.75; }
.rv-standings-combo { font-size: 11px; opacity: 0.75; }

/* Transport bar */
.rv-match-transport {
  flex: 0 0 42px;
  height: 42px;
  background: #18201e;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  position: relative;
  z-index: 20;
}
.rv-match-transport-btn {
  background: transparent;
  border: none;
  color: #e0ecea;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 120ms ease;
}
.rv-match-transport-btn:hover { color: #ffcc22; }
.rv-match-time {
  font-size: 12px;
  font-weight: 600;
  color: #e0ecea;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rv-match-scrubber {
  flex: 1;
  height: 4px;
  accent-color: #ffcc22;
  cursor: pointer;
}

/* Playback screen container */
.rv-match-playback-screen {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rv-match-playback-screen[hidden] {
  display: none !important;
}

/* In-page Setup Wizard Screen (osu!lazer Screen / Wizard Style from Image 2) */
.rv-match-setup-screen {
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
  animation: rvMatchBackdropFadeIn 240ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.rv-match-setup-screen[hidden] {
  display: none !important;
}

.rv-match-setup-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 0 24px 20px;
  overflow-y: auto;
  box-sizing: border-box;
}

/* Top Hanging Header Banner Card ("多人房间回放") */
.rv-match-dialog-header {
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
  box-shadow: none;
  animation: rvMatchHeaderSlideDown 280ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  box-sizing: border-box;
  flex-shrink: 0;
  margin-bottom: 16px;
}
.rv-match-dialog-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.rv-match-title-icon {
  font-size: 24px;
  color: #4ed9c8;
  flex-shrink: 0;
}
.rv-match-dialog-header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.rv-match-dialog-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: -0.01em;
}
.rv-match-dialog-subtitle {
  margin: 0;
  font-size: 12px;
  color: #9dc2b3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rv-match-dialog-close-btn {
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
.rv-match-dialog-close-btn:hover {
  background: rgba(235, 70, 116, 0.3);
  border-color: rgba(235, 70, 116, 0.5);
  color: #ffffff;
  transform: scale(1.06);
}
.rv-match-dialog-close-btn:active {
  transform: scale(0.94);
}

/* Center Setup Content Card ("房间设定") */
.rv-match-dialog-body {
  width: 860px;
  max-width: 90vw;
  background: #16201d;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  box-shadow: none;
  padding: 32px 36px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 20px;
  animation: rvMatchBodyPopIn 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  box-sizing: border-box;
  min-height: 440px;
  flex: 1;
}
.rv-match-section-heading {
  display: flex;
  align-items: center;
}
.rv-match-section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: -0.01em;
}
.rv-match-input-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rv-match-input-label {
  font-size: 12px;
  font-weight: 600;
  color: #90a8a0;
  user-select: none;
}
.rv-match-input-wrap {
  background: #0e1614;
  border: 1.5px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  transition: border-color 150ms ease, background 150ms ease;
}
.rv-match-input-wrap:focus-within {
  border-color: #2feaa8;
  box-shadow: none;
  background: #111b18;
}
.rv-match-input-icon {
  color: rgba(255, 255, 255, 0.45);
  font-size: 16px;
  flex-shrink: 0;
  transition: color 150ms ease;
}
.rv-match-input-wrap:focus-within .rv-match-input-icon {
  color: #2feaa8;
}
.rv-match-input-field {
  flex: 1;
  background: transparent;
  border: none;
  color: #ffffff;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  min-width: 0;
}
.rv-match-input-field::placeholder {
  color: rgba(255, 255, 255, 0.35);
}
.rv-match-dialog-status {
  font-size: 12.5px;
  min-height: 18px;
  line-height: 1.4;
  transition: all 150ms ease;
}
.rv-match-dialog-status.rv-status-error {
  color: #ff5566;
  font-weight: 600;
}
.rv-match-dialog-status.rv-status-loading {
  color: #4ed9c8;
  font-weight: 600;
}
.rv-match-notice {
  margin-top: auto;
  font-size: 12.5px;
  line-height: 1.6;
  color: #ffcc22;
  user-select: none;
}
.rv-match-notice-accent {
  color: #ffcc22;
  font-weight: 700;
}
.rv-match-highlight {
  color: #ffcc22;
  font-weight: 700;
}

/* Bottom Action Footer Bar (Lazer Edge-to-Edge Parallelogram Buttons with Solid Flat Color from Image 2) */
.rv-match-dialog-footer-bar {
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
  animation: rvMatchFooterSlideUp 280ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.rv-match-footer-actions {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 100%;
}
.rv-match-btn-back-lazer {
  background: #db2878;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-bottom: 2px solid rgba(255, 255, 255, 0.35);
  border-right: 1.5px solid rgba(255, 255, 255, 0.25);
  box-shadow: none;
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
.rv-match-btn-back-lazer:hover {
  background: #e63889;
  transform: skewX(-12deg) translateY(-1px);
}
.rv-match-btn-back-lazer:active {
  background: #c71e6c;
  transform: skewX(-12deg) translateY(0);
}
.rv-match-btn-submit-lazer {
  flex: 1;
  background: #2feaa8;
  color: #082218;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-bottom: 2px solid rgba(255, 255, 255, 0.45);
  border-right: 1.5px solid rgba(255, 255, 255, 0.3);
  box-shadow: none;
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
.rv-match-btn-submit-lazer:hover:not(:disabled) {
  background: #46f8b6;
  transform: skewX(-12deg) translateY(-1px);
}
.rv-match-btn-submit-lazer:active:not(:disabled) {
  background: #24d393;
  transform: skewX(-12deg) translateY(0);
}
.rv-match-btn-submit-lazer:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rv-match-btn-skew-content {
  transform: skewX(12deg);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.rv-match-back-chevron {
  font-size: 18px;
}

/* Lazer Animation Keyframes */
@keyframes rvMatchBackdropFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes rvMatchBackdropFadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes rvMatchHeaderSlideDown {
  from { opacity: 0; transform: translateY(-24px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes rvMatchHeaderSlideUp {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-24px); }
}
@keyframes rvMatchBodyPopIn {
  from { opacity: 0; transform: scale(0.94) translateY(12px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes rvMatchBodyPopOut {
  from { opacity: 1; transform: scale(1) translateY(0); }
  to { opacity: 0; transform: scale(0.94) translateY(12px); }
}
@keyframes rvMatchFooterSlideUp {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes rvMatchFooterSlideDown {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(24px); }
}

.rv-row-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
`;
}

