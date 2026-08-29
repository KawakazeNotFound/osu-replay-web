/**
 * Top menu bar following lazer navigation & visual hierarchy.
 *
 * Implements mode switcher (Replay / Auto / Match),
 * URL modal prompt, local file imports (.osz, .osr, .osk), and skin selector.
 */

import { icon, type IconName } from '../results/icons.js';
import { uiSounds } from './uiSounds.js';
import { t } from './i18n.js';

export { notify, notificationsCss, type NotificationType, type NotificationOptions, type NotificationHandle } from './notifications.js';

export interface MenuBarOptions {
  readonly onImportUrl: (url: string) => void;
  readonly onImportOsz: (file: File) => void;
  readonly onImportOsr: (file: File) => void;
  readonly onSelectSkin: (skinName: string) => void;
  readonly onImportSkin: (file: File) => void;
  readonly onSelectMode?: (mode: 'replay' | 'auto' | 'match') => void;
  readonly getActiveMode?: () => 'replay' | 'auto' | 'match';
  readonly onOpenMatchRoom?: () => void;
  readonly onToggleSettings?: () => void;
  readonly onToggleFullscreen?: () => void;
  readonly onReload?: () => void;
  readonly onExit?: () => void;
  readonly isHomePage?: () => boolean;
  readonly getSelectedSkin: () => string;
  readonly getAvailableSkins: () => readonly string[];
}

export interface MenuBarHandle {
  readonly root: HTMLElement;
  readonly userSlot: HTMLElement;
  readonly statusSlot: HTMLElement;
  updateActiveMode(mode: 'replay' | 'auto' | 'match'): void;
  openUrlPrompt(): void;
  updateSkins(): void;
  destroy(): void;
}

export function buildMenuBar(options: MenuBarOptions): MenuBarHandle {
  const root = document.createElement('header');
  root.className = 'rv-top-bar';

  // ---- Left container: Brand + Home + Mode Tabs ----
  const leftGroup = document.createElement('div');
  leftGroup.className = 'rv-menu-left';

  // 1. Brand Logo: Replay Viewer with circular icon
  const brand = document.createElement('div');
  brand.className = 'rv-menu-brand';
  brand.title = t('主页面', 'Home');

  const logoIcon = document.createElement('div');
  logoIcon.className = 'rv-menu-logo-icon';
  logoIcon.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" />
      <polygon points="9.5,7.5 16.5,12 9.5,16.5" />
    </svg>
  `;

  const brandText = document.createElement('span');
  brandText.className = 'rv-menu-brand-text';
  brandText.innerHTML = 'Replay <span class="rv-brand-accent">Viewer</span>';

  brand.append(logoIcon, brandText);
  uiSounds.attachHoverClick(brand, { hover: 'button', click: false });
  brand.addEventListener('click', () => {
    uiSounds.playClick('button');
    options.onExit?.();
  });
  leftGroup.append(brand);

  // 2. Home icon button
  const homeBtn = document.createElement('button');
  homeBtn.type = 'button';
  homeBtn.className = 'rv-top-icon-btn rv-top-home-btn';
  homeBtn.title = t('主页面', 'Home');
  homeBtn.append(icon('home', { className: 'rv-icon' }));
  uiSounds.attachHoverClick(homeBtn, { hover: 'button', click: false });
  homeBtn.addEventListener('click', () => {
    uiSounds.playClick('button');
    options.onExit?.();
  });
  leftGroup.append(homeBtn);

  // 3. Mode Tabs (Single Replay, Auto Play, Multiplayer Match)
  const modeTabs = document.createElement('div');
  modeTabs.className = 'rv-top-mode-tabs';

  const modeButtons = new Map<'replay' | 'auto' | 'match', HTMLButtonElement>();
  const modesList: Array<{ id: 'replay' | 'auto' | 'match'; icon: IconName; label: string }> = [
    { id: 'replay', icon: 'mode-single', label: t('单人回放', 'Single Replay') },
    { id: 'auto', icon: 'mode-auto', label: t('自动演示', 'Auto Play') },
    { id: 'match', icon: 'mode-match', label: t('多人比赛', 'Multiplayer Match') },
  ];

  for (const m of modesList) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `rv-top-mode-tab rv-mode-${m.id}`;
    if (options.getActiveMode?.() === m.id) {
      tab.classList.add('rv-mode-active');
    }
    tab.title = m.label;
    tab.append(icon(m.icon, { className: 'rv-icon' }));
    uiSounds.attachHoverClick(tab, { hover: 'button', click: false });
    tab.addEventListener('click', () => {
      uiSounds.playClick('button');
      for (const [modeKey, btn] of modeButtons.entries()) {
        btn.classList.toggle('rv-mode-active', modeKey === m.id);
      }
      options.onSelectMode?.(m.id);
    });
    modeButtons.set(m.id, tab);
    modeTabs.append(tab);
  }
  leftGroup.append(modeTabs);

  // ---- Right container: Palette + Fullscreen + Separator + User Profile + Live Clock + Settings ----
  const rightGroup = document.createElement('div');
  rightGroup.className = 'rv-menu-right';

  const utilGroup = document.createElement('div');
  utilGroup.className = 'rv-top-util-group';

  // Palette button: opens preset skin dropdown menu
  const paletteBtn = document.createElement('button');
  paletteBtn.type = 'button';
  paletteBtn.className = 'rv-top-icon-btn rv-top-palette-btn';
  paletteBtn.title = t('预设皮肤', 'Preset Skins');
  paletteBtn.append(icon('palette', { className: 'rv-icon' }));
  uiSounds.attachHoverClick(paletteBtn, { hover: 'button', click: false });
  paletteBtn.addEventListener('click', () => {
    openTopMenu(paletteBtn, getPaletteMenuItems);
  });
  utilGroup.append(paletteBtn);

  // Fullscreen button
  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.type = 'button';
  fullscreenBtn.className = 'rv-top-icon-btn rv-top-fullscreen-btn';
  fullscreenBtn.title = t('全屏模式', 'Toggle Fullscreen');
  fullscreenBtn.append(icon('fullscreen', { className: 'rv-icon' }));
  uiSounds.attachHoverClick(fullscreenBtn, { hover: 'button', click: false });
  fullscreenBtn.addEventListener('click', () => {
    uiSounds.playClick('button');
    options.onToggleFullscreen?.();
  });
  utilGroup.append(fullscreenBtn);

  rightGroup.append(utilGroup);

  const divider = document.createElement('div');
  divider.className = 'rv-top-divider';
  rightGroup.append(divider);

  const statusSlot = document.createElement('span');
  statusSlot.className = 'rv-menu-status';

  const userSlot = document.createElement('div');
  userSlot.className = 'rv-menu-user';
  rightGroup.append(userSlot);

  // Live Clock & Session Runtime counter widget
  const clockWidget = document.createElement('div');
  clockWidget.className = 'rv-top-clock-widget';

  const clockIcon = icon('clock', { className: 'rv-icon rv-clock-icon' });
  const clockTextWrap = document.createElement('div');
  clockTextWrap.className = 'rv-clock-text-wrap';

  const clockTime = document.createElement('span');
  clockTime.className = 'rv-clock-time';

  const clockRuntime = document.createElement('span');
  clockRuntime.className = 'rv-clock-runtime';

  clockTextWrap.append(clockTime, clockRuntime);
  clockWidget.append(clockIcon, clockTextWrap);
  rightGroup.append(clockWidget);

  const startTime = Date.now();
  const updateClock = (): void => {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    clockTime.textContent = `${h}:${m}:${s}`;

    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const eh = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
    const em = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
    const es = String(elapsedSec % 60).padStart(2, '0');
    clockRuntime.textContent = `${t('已运行', 'Running')} ${eh}:${em}:${es}`;
  };
  updateClock();
  const clockInterval = window.setInterval(updateClock, 1000);

  // Settings button (Replaces the bell notification button on the far right)
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'rv-top-icon-btn rv-top-settings-btn';
  settingsBtn.title = t('设置与菜单', 'Settings & Menu');
  const gear = icon('settings', { className: 'rv-icon rv-top-gear-icon' });
  settingsBtn.append(gear);
  uiSounds.attachHoverClick(settingsBtn, { hover: 'button', click: false });
  settingsBtn.addEventListener('click', () => {
    openTopMenu(settingsBtn, getFullMenuItems);
  });
  rightGroup.append(settingsBtn);

  root.append(leftGroup, rightGroup);

  // ---- Hidden File Inputs ----
  const createFileInput = (accept: string, onSelect: (f: File) => void): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) onSelect(file);
      input.value = '';
    });
    root.append(input);
    return input;
  };

  const oszFileInput = createFileInput('.osz,.zip', options.onImportOsz);
  const osrFileInput = createFileInput('.osr', options.onImportOsr);
  const oskFileInput = createFileInput('.osk,.zip', options.onImportSkin);

  // ---- URL Import Modal ----
  const openUrlModal = (): void => {
    closeAllMenus();
    uiSounds.playDialog('pop-in');
    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'rv-modal-backdrop';

    const modalBox = document.createElement('div');
    modalBox.className = 'rv-modal-box';

    const title = document.createElement('h3');
    title.className = 'rv-modal-title';
    title.textContent = t('从链接导入', 'Import from URL');

    const desc = document.createElement('p');
    desc.className = 'rv-modal-desc';
    desc.textContent = t(
      '输入 osu! 成绩链接、谱面链接或 ID:',
      'Enter osu! score URL, beatmap URL or ID:',
    );

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rv-modal-input';
    input.placeholder = 'https://osu.ppy.sh/scores/123456 or 123456';

    const actions = document.createElement('div');
    actions.className = 'rv-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rv-modal-btn rv-modal-btn-cancel';
    cancelBtn.textContent = t('取消', 'Cancel');
    uiSounds.attachHoverClick(cancelBtn, { hover: 'button', click: false });

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'rv-modal-btn rv-modal-btn-primary';
    loadBtn.textContent = t('加载', 'Load');
    uiSounds.attachHoverClick(loadBtn, { hover: 'button', click: false });

    const closeModal = (): void => {
      uiSounds.playDialog('pop-out');
      modalBackdrop.remove();
    };

    const submit = (): void => {
      const val = input.value.trim();
      if (val !== '') {
        uiSounds.playClick('dialog-ok');
        closeModal();
        options.onImportUrl(val);
      } else {
        uiSounds.playClick('disabled');
      }
    };

    cancelBtn.addEventListener('click', () => {
      uiSounds.playClick('dialog-cancel');
      closeModal();
    });
    loadBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') {
        uiSounds.playClick('dialog-cancel');
        closeModal();
      }
    });

    actions.append(cancelBtn, loadBtn);
    modalBox.append(title, desc, input, actions);
    modalBackdrop.append(modalBox);
    document.body.append(modalBackdrop);

    setTimeout(() => input.focus(), 50);
  };

  // ---- Menu Management ----
  let activeMenuBtn: HTMLElement | null = null;
  let activeDropdown: HTMLElement | null = null;

  const closeAllMenus = (): void => {
    if (activeDropdown !== null) {
      activeDropdown.remove();
      activeDropdown = null;
    }
    if (activeMenuBtn !== null) {
      activeMenuBtn.classList.remove('rv-menu-btn-active');
      activeMenuBtn = null;
    }
  };

  window.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!root.contains(e.target as Node) && !activeDropdown?.contains(e.target as Node)) {
      if (activeDropdown !== null) uiSounds.playMenu('close');
      closeAllMenus();
    }
  });

  // ---- Menu Item Renderers ----
  interface MenuItemSpec {
    readonly label: string;
    readonly icon?: IconName;
    readonly badge?: string;
    readonly isChecked?: boolean;
    readonly isDivider?: boolean;
    readonly isDanger?: boolean;
    readonly isDisabled?: boolean;
    readonly onClick?: () => void;
    readonly children?: readonly MenuItemSpec[] | (() => readonly MenuItemSpec[]);
  }

  const renderDropdown = (items: readonly MenuItemSpec[], depth = 1): HTMLElement => {
    const menuEl = document.createElement('div');
    menuEl.className = `rv-dropdown-menu depth-${depth}`;
    if (depth > 1) {
      menuEl.classList.add('rv-submenu');
    }

    let activeChildMenu: HTMLElement | null = null;
    let activeRow: HTMLElement | null = null;
    let closeTimer: number | null = null;

    const hasAnyChildren = items.some(it => it.children !== undefined);
    const container = (items.length > 7 && !hasAnyChildren) ? document.createElement('div') : menuEl;
    if (container !== menuEl) {
      container.className = 'rv-menu-scroll-container';
      menuEl.append(container);
    }

    for (const item of items) {
      if (item.isDivider === true) {
        const dividerEl = document.createElement('div');
        dividerEl.className = 'rv-menu-divider';
        container.append(dividerEl);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'rv-menu-row';
      if (item.children !== undefined) row.classList.add('rv-has-submenu');
      if (item.isDanger === true) row.classList.add('rv-row-danger');
      if (item.isDisabled === true) row.classList.add('rv-row-disabled');

      const labelWrapper = document.createElement('span');
      labelWrapper.className = 'rv-menu-row-label';

      if (item.isChecked === true) {
        const check = document.createElement('span');
        check.className = 'rv-menu-check';
        check.append(icon('check', { className: 'rv-icon' }));
        labelWrapper.append(check);
      }

      if (item.icon !== undefined) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'rv-menu-item-icon';
        iconSpan.append(icon(item.icon, { className: 'rv-icon' }));
        labelWrapper.append(iconSpan);
      }

      labelWrapper.append(document.createTextNode(item.label));
      row.append(labelWrapper);

      if (item.badge !== undefined) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'rv-menu-badge';
        badgeEl.textContent = item.badge;
        row.append(badgeEl);
      } else if (item.children !== undefined) {
        const arrow = document.createElement('span');
        arrow.className = 'rv-menu-arrow';
        arrow.append(icon('chevron-right', { className: 'rv-icon' }));
        row.append(arrow);
      }

      if (item.isDisabled === true) {
        row.addEventListener('click', (e: MouseEvent) => {
          e.stopPropagation();
          uiSounds.playClick('disabled');
        });
      } else if (item.children !== undefined) {
        const openChild = (): void => {
          if (closeTimer !== null) {
            clearTimeout(closeTimer);
            closeTimer = null;
          }
          if (activeChildMenu !== null && activeRow === row) return;
          if (activeChildMenu !== null) {
            activeChildMenu.remove();
            activeChildMenu = null;
          }
          if (activeRow !== null) {
            activeRow.classList.remove('rv-row-active');
          }

          activeRow = row;
          row.classList.add('rv-row-active');
          uiSounds.playMenu('sub-open');

          const subItems = typeof item.children === 'function' ? item.children() : item.children!;
          const childMenu = renderDropdown(subItems, depth + 1);
          childMenu.style.top = `${row.offsetTop}px`;
          childMenu.style.left = `${row.offsetLeft + row.offsetWidth}px`;
          menuEl.append(childMenu);
          activeChildMenu = childMenu;
        };

        row.addEventListener('pointerenter', () => {
          uiSounds.playHover('default');
          openChild();
        });
        row.addEventListener('pointerleave', (e: PointerEvent) => {
          if (activeChildMenu !== null) {
            if (closeTimer !== null) clearTimeout(closeTimer);
            closeTimer = window.setTimeout(() => {
              const related = e.relatedTarget as Node | null;
              if (activeChildMenu && !activeChildMenu.contains(related) && !row.contains(related)) {
                activeChildMenu.remove();
                activeChildMenu = null;
                row.classList.remove('rv-row-active');
              }
            }, 140);
          }
        });
      } else {
        row.addEventListener('pointerenter', () => {
          uiSounds.playHover('default');
          if (activeChildMenu !== null) {
            activeChildMenu.remove();
            activeChildMenu = null;
          }
          if (activeRow !== null) {
            activeRow.classList.remove('rv-row-active');
            activeRow = null;
          }
        });
        if (item.onClick !== undefined) {
          row.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            if (item.isDanger === true) {
              uiSounds.playClick('dialog-dangerous');
            } else if (item.isChecked !== undefined) {
              uiSounds.playToggle(!item.isChecked);
            } else {
              uiSounds.playClick('default');
            }
            closeAllMenus();
            item.onClick!();
          });
        }
      }

      container.append(row);
    }

    return menuEl;
  };

  const openTopMenu = (btn: HTMLElement, getItems: () => readonly MenuItemSpec[]): void => {
    if (activeMenuBtn === btn) {
      uiSounds.playMenu('close');
      closeAllMenus();
      return;
    }
    closeAllMenus();

    activeMenuBtn = btn;
    btn.classList.add('rv-menu-btn-active');
    uiSounds.playMenu('open');

    const dropdown = renderDropdown(getItems(), 1);
    const rect = btn.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom - rootRect.top}px`;

    // If button is on the right side of the screen, align dropdown to the right edge of button
    const estimatedWidth = 200;
    if (rect.left + estimatedWidth > window.innerWidth) {
      dropdown.style.right = `${window.innerWidth - rect.right}px`;
      dropdown.style.left = 'auto';
    } else {
      dropdown.style.left = `${rect.left - rootRect.left}px`;
      dropdown.style.right = 'auto';
    }

    root.append(dropdown);
    activeDropdown = dropdown;
  };

  // ---- Menu Definitions ----
  const getPresetSkinItems = (): readonly MenuItemSpec[] => {
    const selected = options.getSelectedSkin();
    return options.getAvailableSkins().map(skinName => ({
      label: skinName,
      isChecked: skinName === selected,
      onClick: () => options.onSelectSkin(skinName),
    }));
  };

  const getPaletteMenuItems = (): readonly MenuItemSpec[] => {
    const selected = options.getSelectedSkin();
    const presetItems: MenuItemSpec[] = options.getAvailableSkins().map(skinName => ({
      label: skinName,
      isChecked: skinName === selected,
      onClick: () => options.onSelectSkin(skinName),
    }));

    return [
      ...presetItems,
      { isDivider: true, label: '' },
      {
        label: t('导入皮肤 (.osk / .zip)…', 'Import Skin (.osk / .zip)…'),
        onClick: () => oskFileInput.click(),
      },
    ];
  };

  const getModeItems = (): readonly MenuItemSpec[] => {
    const cur = options.getActiveMode?.() ?? 'replay';
    return [
      {
        label: t('单人回放', 'Single Replay'),
        icon: 'mode-single',
        isChecked: cur === 'replay',
        onClick: () => options.onSelectMode?.('replay'),
      },
      {
        label: t('自动演示', 'Auto Play'),
        icon: 'mode-auto',
        isChecked: cur === 'auto',
        onClick: () => options.onSelectMode?.('auto'),
      },
      {
        label: t('多人比赛', 'Multiplayer Match'),
        icon: 'mode-match',
        isChecked: cur === 'match',
        onClick: () => options.onSelectMode?.('match'),
      },
    ];
  };

  const getFileMenuItems = (): readonly MenuItemSpec[] => {
    const isHome = options.isHomePage !== undefined ? options.isHomePage() : false;
    return [
      {
        label: t('导入', 'Import'),
        children: [
          {
            label: t('从链接导入…', 'Import from URL…'),
            onClick: openUrlModal,
          },
          {
            label: t('从比赛房间导入…', 'Import from Match Room…'),
            icon: 'mode-match',
            onClick: () => options.onOpenMatchRoom?.(),
          },
          {
            label: t('从本地导入', 'Import Local Files'),
            children: [
              {
                label: t('导入 .osz 谱面包…', 'Import .osz Beatmap…'),
                onClick: () => oszFileInput.click(),
              },
              {
                label: t('导入 .osr 回放…', 'Import .osr Replay…'),
                onClick: () => osrFileInput.click(),
              },
            ],
          },
        ],
      },
      { isDivider: true, label: '' },
      {
        label: t('重新加载', 'Reload'),
        onClick: () => options.onReload?.(),
      },
      {
        label: t('主页面', 'Home'),
        isDanger: true,
        isDisabled: isHome,
        onClick: isHome ? undefined : () => options.onExit?.(),
      },
    ];
  };

  const getViewMenuItems = (): readonly MenuItemSpec[] => [
    {
      label: t('模式', 'Mode'),
      children: getModeItems,
    },
    {
      label: t('皮肤', 'Skins'),
      children: [
        {
          label: t('预设皮肤', 'Presets'),
          children: getPresetSkinItems,
        },
        {
          label: t('导入皮肤 (.osk / .zip)…', 'Import Skin (.osk / .zip)…'),
          onClick: () => oskFileInput.click(),
        },
      ],
    },
    { isDivider: true, label: '' },
    {
      label: t('旧版播放器', 'Legacy Viewer'),
      onClick: () => {
        window.location.href = '/legacy/';
      },
    },
    {
      label: t('全屏模式', 'Toggle Fullscreen'),
      badge: 'F11',
      onClick: () => options.onToggleFullscreen?.(),
    },
  ];

  const getFullMenuItems = (): readonly MenuItemSpec[] => [
    { label: t('文件', 'File'), children: getFileMenuItems },
    { label: t('查看', 'View'), children: getViewMenuItems },
    { isDivider: true, label: '' },
    {
      label: t('全屏模式', 'Toggle Fullscreen'),
      badge: 'F11',
      onClick: () => options.onToggleFullscreen?.(),
    },
    {
      label: t('旧版播放器', 'Legacy Viewer'),
      onClick: () => {
        window.location.href = '/legacy/';
      },
    },
    {
      label: t('重新加载', 'Reload'),
      onClick: () => options.onReload?.(),
    },
    { isDivider: true, label: '' },
    {
      label: t('回放设置面板', 'Replay Settings Panel'),
      icon: 'settings',
      onClick: () => options.onToggleSettings?.(),
    },
    {
      label: t('主页面', 'Home'),
      isDanger: true,
      onClick: () => options.onExit?.(),
    },
  ];

  return {
    root,
    userSlot,
    statusSlot,
    updateActiveMode(mode: 'replay' | 'auto' | 'match'): void {
      for (const [m, btn] of modeButtons.entries()) {
        btn.classList.toggle('rv-mode-active', m === mode);
      }
    },
    openUrlPrompt: openUrlModal,
    updateSkins(): void {
      // Re-render skin list if dropdown is open
    },
    destroy(): void {
      clearInterval(clockInterval);
      closeAllMenus();
      root.remove();
    },
  };
}

export function menuBarCss(): string {
  return `
/* Top Navigation / Menu Bar (osu!lazer Top Header style from Image 2) */
.rv-top-bar {
  flex: 0 0 46px;
  height: 46px;
  background: #15221e;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  user-select: none;
  font-family: inherit;
  font-size: 13px;
  color: #d8e6e4;
  position: relative;
  z-index: 100;
  padding: 0 4px;
}

.rv-menu-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Brand Logo */
.rv-menu-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 36px;
  border-radius: 4px;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: #ffffff;
  cursor: pointer;
  transition: background 120ms ease;
}
.rv-menu-brand:hover {
  background: rgba(255, 255, 255, 0.08);
}
.rv-menu-logo-icon {
  color: #4ed9c8;
  display: flex;
  align-items: center;
}
.rv-brand-accent {
  color: #4ed9c8;
}

/* Settings button with gear */
.rv-top-settings-btn {
  background: transparent;
  border: none;
  color: #a2b8b2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.rv-top-settings-btn:hover,
.rv-top-settings-btn.rv-menu-btn-active {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}
.rv-top-gear-icon {
  font-size: 18px;
}

/* Nav icon buttons */
.rv-top-icon-btn {
  background: transparent;
  border: none;
  color: #a2b8b2;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  font-size: 18px;
  transition: all 120ms ease;
}
.rv-top-icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

/* Mode tabs with active underline indicator */
.rv-top-mode-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
}
.rv-top-mode-tab {
  background: transparent;
  border: none;
  color: #8fa6a0;
  width: 40px;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  cursor: pointer;
  position: relative;
  transition: color 120ms ease;
}
.rv-top-mode-tab:hover {
  color: #ffffff;
}
.rv-top-mode-tab.rv-mode-active {
  color: #2feaa8;
}
.rv-top-mode-tab.rv-mode-active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 6px;
  right: 6px;
  height: 3px;
  background: #2feaa8;
  border-radius: 3px 3px 0 0;
  box-shadow: 0 0 8px #2feaa8;
}

/* Right header group */
.rv-menu-right {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 10px;
}

.rv-top-util-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.rv-top-divider {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.12);
}

.rv-menu-user {
  display: flex;
  align-items: center;
}

/* Live Clock & Session Runtime counter widget */
.rv-top-clock-widget {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  color: #ffffff;
  user-select: none;
}
.rv-clock-icon {
  font-size: 18px;
  color: #a4c2ba;
}
.rv-clock-text-wrap {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}
.rv-clock-time {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #ffffff;
  letter-spacing: -0.01em;
}
.rv-clock-runtime {
  font-size: 9.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #ff6688;
}

/* Dropdown Menu & Submenus (osu!lazer sharp flat style) */
.rv-dropdown-menu {
  position: absolute;
  min-width: 190px;
  background: #253330;
  border-radius: 0;
  box-shadow: none;
  border: 1px solid rgba(255, 255, 255, 0.05);
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  z-index: 1000;
  overflow: visible !important;
  transform-origin: top left;
  animation: rvMenuUnroll 180ms cubic-bezier(0.05, 0.9, 0.1, 1) forwards;
}

.rv-dropdown-menu.rv-submenu {
  position: absolute;
  border-radius: 0;
  box-shadow: none;
  border: 1px solid rgba(255, 255, 255, 0.05);
  transform-origin: top left;
  animation: rvSubmenuUnroll 160ms cubic-bezier(0.05, 0.9, 0.1, 1) forwards;
}

/* Scroll container for long list of presets */
.rv-menu-scroll-container {
  max-height: 360px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: #5c706c transparent;
}
.rv-menu-scroll-container::-webkit-scrollbar {
  width: 5px;
}
.rv-menu-scroll-container::-webkit-scrollbar-track {
  background: transparent;
}
.rv-menu-scroll-container::-webkit-scrollbar-thumb {
  background: #5c706c;
  border-radius: 3px;
}
.rv-menu-scroll-container::-webkit-scrollbar-thumb:hover {
  background: #7a948f;
}

@keyframes rvMenuUnroll {
  0% {
    transform: scaleY(0);
    opacity: 0.3;
  }
  100% {
    transform: scaleY(1);
    opacity: 1;
  }
}

@keyframes rvSubmenuUnroll {
  0% {
    transform: scaleX(0.7) scaleY(0.7);
    opacity: 0.3;
  }
  100% {
    transform: scaleX(1) scaleY(1);
    opacity: 1;
  }
}

.rv-menu-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding: 0 16px;
  gap: 16px;
  color: #e0ecea;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  position: relative;
  background: #253330;
  transition: background 60ms ease, color 60ms ease;
  user-select: none;
}
.rv-menu-row:hover,
.rv-menu-row.rv-row-active {
  background: #3d524d;
  color: #ffffff;
}
.rv-menu-row.rv-row-danger {
  color: #ff5577;
}
.rv-menu-row.rv-row-danger .rv-menu-row-label {
  color: #ff5577;
}
.rv-menu-row.rv-row-danger:hover:not(.rv-row-disabled),
.rv-menu-row.rv-row-danger.rv-row-active:not(.rv-row-disabled) {
  background: #4a1f28;
  color: #ff7799;
}
.rv-menu-row.rv-row-danger:hover:not(.rv-row-disabled) .rv-menu-row-label,
.rv-menu-row.rv-row-danger.rv-row-active:not(.rv-row-disabled) .rv-menu-row-label {
  color: #ff7799;
}
.rv-menu-row.rv-row-disabled {
  cursor: default;
  background: rgba(0, 0, 0, 0.3);
  opacity: 0.5;
}
.rv-menu-row.rv-row-disabled:hover {
  background: rgba(0, 0, 0, 0.3) !important;
}
.rv-menu-row.rv-row-danger.rv-row-disabled,
.rv-menu-row.rv-row-danger.rv-row-disabled .rv-menu-row-label {
  color: #ff5577 !important;
}
.rv-menu-row-label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rv-menu-check {
  color: #ffcc22;
  font-size: 13px;
  display: inline-flex; align-items: center;
  margin-right: 4px;
}
.rv-menu-item-icon {
  font-size: 14px;
  color: #4ed9c8;
  display: inline-flex; align-items: center;
  margin-right: 6px;
}
.rv-menu-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.4);
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 0.05em;
}
.rv-menu-arrow {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.5);
  display: inline-flex; align-items: center;
}
.rv-menu-divider {
  height: 1px;
  margin: 4px 10px;
  background: rgba(255, 255, 255, 0.08);
}

/* URL Modal */
.rv-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  animation: rvFadeIn 150ms ease forwards;
}
.rv-modal-box {
  width: 440px;
  background: #253330;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 0;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: rvModalPop 180ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
@keyframes rvModalPop {
  0% { opacity: 0; transform: scale(0.92) translateY(6px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes rvFadeIn {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
.rv-modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #ffffff;
}
.rv-modal-desc {
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
}
.rv-modal-input {
  width: 100%;
  box-sizing: border-box;
  background: #192422;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 0;
  color: #ffffff;
  font-family: inherit;
  font-size: 13px;
  padding: 8px 12px;
  outline: none;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.rv-modal-input:focus {
  border-color: #4ed9c8;
  box-shadow: 0 0 8px rgba(78, 217, 200, 0.3);
}
.rv-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 6px;
}
.rv-modal-btn {
  padding: 7px 16px;
  border-radius: 0;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 120ms ease;
}
.rv-modal-btn-cancel {
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
}
.rv-modal-btn-cancel:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}
.rv-modal-btn-primary {
  background: #4ed9c8;
  color: #121e1c;
}
.rv-modal-btn-primary:hover {
  background: #63ecd9;
  box-shadow: 0 0 10px rgba(78, 217, 200, 0.4);
}
`;
}

