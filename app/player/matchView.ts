/**
 * Multi-replay match view & room modal (osu!lazer multiplayer match viewer).
 *
 * Implements room fetching, map selection, N-canvas responsive grid layout,
 * live standings leaderboard, and shared audio/transport synchronization.
 */

import { icon } from '../results/icons.js';
import {
  fetchMatchRoom, parseRoomRef, playableCount,
  type MatchMap, type MatchRoom,
} from './matchRoom.js';
import { loadMatchMap } from './load.js';
import { createMatch, type MatchHandle, type MatchStanding } from './match.js';
import { loadSkin, DEFAULT_SKIN } from './skins.js';

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
  destroy(): void;
}

export function buildMatchView(options: MatchViewOptions): MatchViewHandle {
  const root = document.createElement('div');
  root.className = 'rv-match-screen';
  root.hidden = true;

  // Header / Top status bar
  const header = document.createElement('div');
  header.className = 'rv-match-header';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'rv-match-btn rv-match-back-btn';
  backBtn.append(icon('rewind', { className: 'rv-icon' }));
  backBtn.append(document.createTextNode('退出比赛 (Exit Match)'));
  backBtn.addEventListener('click', () => {
    stopCurrentMatch();
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
  header.append(backBtn, titleInfo);

  // Main stage containing the multi-canvas grid
  const gridStage = document.createElement('div');
  gridStage.className = 'rv-match-grid-stage';

  // Floating Standings / Leaderboard overlay
  const standingsEl = document.createElement('div');
  standingsEl.className = 'rv-match-standings';

  const standingsHeader = document.createElement('div');
  standingsHeader.className = 'rv-match-standings-header';
  standingsHeader.textContent = '实时排名 (Leaderboard)';

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

  root.append(header, gridStage, standingsEl, transport);
  options.host.append(root);

  let activeMatch: MatchHandle | null = null;
  let standingsTimer: number | null = null;
  let isPlaying = false;
  let currentRoom: MatchRoom | null = null;

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

  const stopCurrentMatch = (): void => {
    if (standingsTimer !== null) {
      clearInterval(standingsTimer);
      standingsTimer = null;
    }
    if (activeMatch !== null) {
      activeMatch.destroy();
      activeMatch = null;
    }
    gridStage.replaceChildren();
    isPlaying = false;
    root.hidden = true;
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

  // ---- Keydown hotkey for Space play/pause in Match view ----
  const onKeyDown = (e: KeyboardEvent) => {
    if (root.hidden || activeMatch === null) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playPauseToggle();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // ---- Map Loader & Grid Orchestrator ----
  const loadAndPlayMap = async (map: MatchMap): Promise<void> => {
    stopCurrentMatch();
    options.log(`Loading match map: ${map.title} [${map.version}]…`);

    mapTitle.textContent = `${map.artist} - ${map.title}`;
    mapSub.textContent = `[${map.version}] • ${currentRoom?.name ?? 'Multiplayer Match'}`;

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
    isPlaying = true;
    playBtn.replaceChildren(icon('pause', { className: 'rv-icon' }));

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

    options.log('Match playing!');
  };

  // ---- Room Picker Modal Dialog ----
  const openRoomDialog = (): void => {
    const backdrop = document.createElement('div');
    backdrop.className = 'rv-modal-backdrop';

    const box = document.createElement('div');
    box.className = 'rv-modal-box rv-match-modal-box';

    const title = document.createElement('h3');
    title.className = 'rv-modal-title';
    title.textContent = '多人房间回放 / Multiplayer Match Room';

    const desc = document.createElement('p');
    desc.className = 'rv-modal-desc';
    desc.textContent = '输入 osu! 比赛链接或房间 ID (Enter Match URL or Room ID):';

    const inputRow = document.createElement('div');
    inputRow.className = 'rv-match-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rv-modal-input';
    input.placeholder = 'https://osu.ppy.sh/community/matches/114979109 or 114979109';

    const fetchBtn = document.createElement('button');
    fetchBtn.type = 'button';
    fetchBtn.className = 'rv-modal-btn rv-modal-btn-primary';
    fetchBtn.textContent = '获取房间 (Fetch)';

    inputRow.append(input, fetchBtn);

    const statusMsg = document.createElement('div');
    statusMsg.className = 'rv-match-modal-status';

    const mapListContainer = document.createElement('div');
    mapListContainer.className = 'rv-match-map-list';
    mapListContainer.style.display = 'none';

    const actions = document.createElement('div');
    actions.className = 'rv-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rv-modal-btn rv-modal-btn-cancel';
    cancelBtn.textContent = '关闭 (Close)';
    cancelBtn.addEventListener('click', () => backdrop.remove());

    actions.append(cancelBtn);
    box.append(title, desc, inputRow, statusMsg, mapListContainer, actions);
    backdrop.append(box);
    document.body.append(backdrop);

    const onFetch = async (): Promise<void> => {
      const val = input.value.trim();
      const roomId = parseRoomRef(val);
      if (roomId === null) {
        statusMsg.textContent = '请输入有效的比赛链接或纯数字房间 ID (Invalid Room ID)';
        statusMsg.className = 'rv-match-modal-status rv-status-error';
        return;
      }

      statusMsg.textContent = '正在获取比赛房间信息 (Fetching room data)…';
      statusMsg.className = 'rv-match-modal-status';
      mapListContainer.style.display = 'none';
      mapListContainer.replaceChildren();

      try {
        const room = await fetchMatchRoom(roomId);
        currentRoom = room;
        statusMsg.textContent = `房间: ${room.name} (${room.maps.length} 局谱面)`;
        statusMsg.className = 'rv-match-modal-status rv-status-success';

        mapListContainer.style.display = 'flex';
        room.maps.forEach((m, idx) => {
          const availCount = playableCount(m);
          const mapCard = document.createElement('div');
          mapCard.className = 'rv-match-map-card';
          if (availCount === 0) {
            mapCard.classList.add('rv-map-unplayable');
            mapCard.title = '该谱面无可用回放 (No replays stored)';
          }

          const mapNumber = document.createElement('span');
          mapNumber.className = 'rv-map-card-number';
          mapNumber.textContent = `#${idx + 1}`;

          const mapDetails = document.createElement('div');
          mapDetails.className = 'rv-map-card-details';

          const titleText = document.createElement('div');
          titleText.className = 'rv-map-card-title';
          titleText.textContent = `${m.artist} - ${m.title}`;

          const diffText = document.createElement('div');
          diffText.className = 'rv-map-card-diff';
          diffText.textContent = `[${m.version}] • ${availCount} / ${m.scores.length} 玩家回放可用`;

          mapDetails.append(titleText, diffText);
          mapCard.append(mapNumber, mapDetails);

          if (availCount > 0) {
            mapCard.addEventListener('click', () => {
              backdrop.remove();
              void loadAndPlayMap(m).catch(err => {
                console.error(err);
                options.log(`Match load failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            });
          }

          mapListContainer.append(mapCard);
        });
      } catch (err) {
        statusMsg.textContent = `获取失败: ${err instanceof Error ? err.message : String(err)}`;
        statusMsg.className = 'rv-match-modal-status rv-status-error';
      }
    };

    fetchBtn.addEventListener('click', () => void onFetch());
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void onFetch();
      if (e.key === 'Escape') backdrop.remove();
    });

    setTimeout(() => input.focus(), 50);
  };

  return {
    root,
    openRoomDialog,
    loadAndPlayMap,
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      stopCurrentMatch();
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
}

.rv-match-header {
  flex: 0 0 46px;
  height: 46px;
  background: #1c2624;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
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
}
.rv-match-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #ffffff;
}

.rv-match-title-info {
  display: flex;
  flex-direction: column;
}
.rv-match-map-title {
  font-size: 13.5px;
  font-weight: 700;
  color: #ffffff;
}
.rv-match-map-sub {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.6);
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
}
.rv-team-bg-red { background: rgba(230, 40, 70, 0.85); }
.rv-team-bg-blue { background: rgba(40, 130, 240, 0.85); }

/* Live Standings Leaderboard */
.rv-match-standings {
  position: absolute;
  top: 56px;
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

/* Match Room Modal */
.rv-match-modal-box {
  width: 520px;
  max-width: 90vw;
}
.rv-match-input-row {
  display: flex;
  gap: 8px;
}
.rv-match-modal-status {
  font-size: 12.5px;
  padding: 4px 0;
  min-height: 18px;
}
.rv-status-error { color: #ff5566; }
.rv-status-success { color: #4ed9c8; }

.rv-match-map-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 6px;
  background: #192422;
}
.rv-match-map-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 4px;
  background: #253330;
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.rv-match-map-card:hover {
  background: #364844;
  border-color: rgba(78, 217, 200, 0.4);
}
.rv-match-map-card.rv-map-unplayable {
  opacity: 0.4;
  cursor: not-allowed;
  background: #1c2624;
}
.rv-map-card-number {
  font-size: 14px;
  font-weight: 800;
  color: #4ed9c8;
}
.rv-map-card-details {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rv-map-card-title {
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rv-map-card-diff {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.7);
}
`;
}
