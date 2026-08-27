/** Modal used when a local beatmap set contains multiple difficulties. */

import type { LocalDifficulty } from './localBeatmap.js';
import { icon } from '../results/icons.js';
import { uiSounds } from './uiSounds.js';

const MODE_NAMES = ['osu!standard', 'osu!taiko', 'osu!catch', 'osu!mania'] as const;

export function difficultyPickerCss(): string {
  return `
.rv-difficulty-backdrop {
  position: fixed; inset: 0; z-index: 1200;
  display: grid; place-items: center;
  padding: 28px;
  background: rgba(7, 5, 10, 0.78);
  backdrop-filter: blur(8px);
}
.rv-difficulty-dialog {
  width: min(720px, 100%); max-height: min(760px, calc(100vh - 56px));
  display: flex; flex-direction: column; overflow: hidden;
  color: #fff; background: #211a25;
  border: 1px solid rgba(255, 255, 255, 0.13); border-radius: 14px;
  box-shadow: 0 22px 70px rgba(0, 0, 0, 0.55);
}
.rv-difficulty-heading { padding: 22px 24px 14px; }
.rv-difficulty-title { margin: 0; font-size: 22px; line-height: 1.25; }
.rv-difficulty-help { margin: 7px 0 0; color: rgba(255, 255, 255, 0.65); font-size: 13px; }
.rv-difficulty-list {
  display: flex; flex-direction: column; gap: 8px;
  margin: 0; padding: 6px 14px 14px; overflow-y: auto; list-style: none;
}
.rv-difficulty-choice {
  width: 100%; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 18px;
  padding: 14px 16px; border: 1px solid transparent; border-radius: 9px;
  color: inherit; background: rgba(255, 255, 255, 0.055); text-align: left; cursor: pointer;
}
.rv-difficulty-choice:hover, .rv-difficulty-choice:focus-visible {
  outline: none; border-color: rgba(255, 204, 34, 0.7); background: rgba(255, 204, 34, 0.11);
}
.rv-difficulty-main { min-width: 0; }
.rv-difficulty-version {
  display: block; overflow: hidden; color: #fff; font-weight: 700;
  text-overflow: ellipsis; white-space: nowrap;
}
.rv-difficulty-song {
  display: block; margin-top: 3px; overflow: hidden; color: rgba(255, 255, 255, 0.68);
  font-size: 12px; text-overflow: ellipsis; white-space: nowrap;
}
.rv-difficulty-meta {
  display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 8px;
  color: rgba(255, 255, 255, 0.54); font-size: 11px;
}
.rv-difficulty-choice > .rv-icon { width: 20px; height: 20px; color: #ffcc22; }
.rv-difficulty-actions {
  display: flex; justify-content: flex-end; padding: 14px 20px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
}
.rv-difficulty-cancel {
  border: 0; border-radius: 7px; padding: 8px 16px;
  color: rgba(255, 255, 255, 0.78); background: rgba(255, 255, 255, 0.08);
  font: inherit; cursor: pointer;
}
.rv-difficulty-cancel:hover, .rv-difficulty-cancel:focus-visible {
  outline: none; color: #fff; background: rgba(255, 255, 255, 0.14);
}
`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Resolves to the selected array index, or null when the modal is dismissed. */
export function chooseLocalDifficulty(
  choices: readonly LocalDifficulty[],
): Promise<number | null> {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'rv-difficulty-backdrop';

    const dialog = document.createElement('section');
    dialog.className = 'rv-difficulty-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'rv-difficulty-title');

    const heading = document.createElement('header');
    heading.className = 'rv-difficulty-heading';
    const title = document.createElement('h2');
    title.id = 'rv-difficulty-title';
    title.className = 'rv-difficulty-title';
    title.textContent = '选择难度 (Select difficulty)';
    const help = document.createElement('p');
    help.className = 'rv-difficulty-help';
    help.textContent = '此谱面包包含多个难度。请选择要生成自动演示的一个。';
    heading.append(title, help);

    const list = document.createElement('ol');
    list.className = 'rv-difficulty-list';

    let settled = false;
    const finish = (index: number | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      uiSounds.playDialog('pop-out');
      resolve(index);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(null);
    };

    choices.forEach((choice, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rv-difficulty-choice';

      const main = document.createElement('span');
      main.className = 'rv-difficulty-main';
      const version = document.createElement('span');
      version.className = 'rv-difficulty-version';
      version.textContent = choice.version !== '' ? choice.version : choice.entry;
      const song = document.createElement('span');
      song.className = 'rv-difficulty-song';
      song.textContent = `${choice.artist || 'Unknown artist'} — ${choice.title || 'Unknown title'}`;
      const meta = document.createElement('span');
      meta.className = 'rv-difficulty-meta';
      for (const value of [
        MODE_NAMES[choice.mode] ?? `mode ${choice.mode}`,
        `${choice.objectCount} objects`,
        `AR ${formatNumber(choice.approachRate)}`,
        `OD ${formatNumber(choice.overallDifficulty)}`,
        `CS ${formatNumber(choice.circleSize)}`,
      ]) {
        const field = document.createElement('span');
        field.textContent = value;
        meta.append(field);
      }
      main.append(version, song, meta);
      button.append(main, icon('chevron-right', { className: 'rv-icon' }));
      uiSounds.attachHoverClick(button, { hover: 'default', click: false });
      button.addEventListener('click', () => {
        uiSounds.playClick('default');
        finish(index);
      });
      item.append(button);
      list.append(item);
    });

    const actions = document.createElement('footer');
    actions.className = 'rv-difficulty-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'rv-difficulty-cancel';
    cancel.textContent = '取消 (Cancel)';
    uiSounds.attachHoverClick(cancel, { hover: 'button', click: false });
    cancel.addEventListener('click', () => {
      uiSounds.playClick('dialog-cancel');
      finish(null);
    });
    actions.append(cancel);

    dialog.append(heading, list, actions);
    backdrop.append(dialog);
    backdrop.addEventListener('pointerdown', event => {
      if (event.target === backdrop) finish(null);
    });
    document.addEventListener('keydown', onKeyDown);
    document.body.append(backdrop);
    uiSounds.playDialog('pop-in');
    list.querySelector<HTMLButtonElement>('button')?.focus();
  });
}
