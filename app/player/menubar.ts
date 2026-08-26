/**
 * Top menu bar for the Replay Viewer (osu!lazer Editor style).
 *
 * Implements nested dropdown submenus with non-linear spring expansion,
 * URL modal prompt, local file imports (.osu, .osz, .osr, .osk), and skin selector.
 */

import { icon, type IconName } from '../results/icons.js';

export interface MenuBarOptions {
  readonly onImportUrl: (url: string) => void;
  readonly onImportOsu: (file: File) => void;
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
  readonly getSelectedSkin: () => string;
  readonly getAvailableSkins: () => readonly string[];
}

export interface MenuBarHandle {
  readonly root: HTMLElement;
  readonly userSlot: HTMLElement;
  readonly statusSlot: HTMLElement;
  updateSkins(): void;
  destroy(): void;
}

export function buildMenuBar(options: MenuBarOptions): MenuBarHandle {
  const root = document.createElement('header');
  root.className = 'rv-top-bar';

  // ---- Left container: Brand + Menu Items ----
  const leftGroup = document.createElement('div');
  leftGroup.className = 'rv-menu-left';

  // Brand / Logo
  const brand = document.createElement('div');
  brand.className = 'rv-menu-brand';

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
  leftGroup.append(brand);

  // Menu bar items container
  const menuBarItems = document.createElement('nav');
  menuBarItems.className = 'rv-menu-items';
  leftGroup.append(menuBarItems);

  // ---- Right container: Status + User Profile ----
  const rightGroup = document.createElement('div');
  rightGroup.className = 'rv-menu-right';

  const statusSlot = document.createElement('span');
  statusSlot.className = 'rv-menu-status';

  const userSlot = document.createElement('div');
  userSlot.className = 'rv-menu-user';

  rightGroup.append(statusSlot, userSlot);
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

  const osuFileInput = createFileInput('.osu', options.onImportOsu);
  const oszFileInput = createFileInput('.osz,.zip', options.onImportOsz);
  const osrFileInput = createFileInput('.osr', options.onImportOsr);
  const oskFileInput = createFileInput('.osk,.zip', options.onImportSkin);

  // ---- URL Import Modal ----
  const openUrlModal = (): void => {
    closeAllMenus();
    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'rv-modal-backdrop';

    const modalBox = document.createElement('div');
    modalBox.className = 'rv-modal-box';

    const title = document.createElement('h3');
    title.className = 'rv-modal-title';
    title.textContent = '从链接导入 / Import from URL';

    const desc = document.createElement('p');
    desc.className = 'rv-modal-desc';
    desc.textContent = '输入 osu! 成绩链接、谱面链接或 ID (Enter Score URL, Beatmap URL or ID):';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rv-modal-input';
    input.placeholder = 'https://osu.ppy.sh/scores/123456 or 123456';

    const actions = document.createElement('div');
    actions.className = 'rv-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rv-modal-btn rv-modal-btn-cancel';
    cancelBtn.textContent = '取消 (Cancel)';

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'rv-modal-btn rv-modal-btn-primary';
    loadBtn.textContent = '加载 (Load)';

    const submit = (): void => {
      const val = input.value.trim();
      if (val !== '') {
        modalBackdrop.remove();
        options.onImportUrl(val);
      }
    };

    cancelBtn.addEventListener('click', () => modalBackdrop.remove());
    loadBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') modalBackdrop.remove();
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

    // If a menu tier has leaf items with no submenus and > 7 items (like 12 preset skins),
    // wrap the rows in a scroll container with custom lazer scrollbar.
    const hasAnyChildren = items.some(it => it.children !== undefined);
    const container = (items.length > 7 && !hasAnyChildren) ? document.createElement('div') : menuEl;
    if (container !== menuEl) {
      container.className = 'rv-menu-scroll-container';
      menuEl.append(container);
    }

    for (const item of items) {
      if (item.isDivider === true) {
        const divider = document.createElement('div');
        divider.className = 'rv-menu-divider';
        container.append(divider);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'rv-menu-row';
      if (item.children !== undefined) row.classList.add('rv-has-submenu');

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
        const badge = document.createElement('span');
        badge.className = 'rv-menu-badge';
        badge.textContent = item.badge;
        row.append(badge);
      } else if (item.children !== undefined) {
        const arrow = document.createElement('span');
        arrow.className = 'rv-menu-arrow';
        arrow.append(icon('chevron-right', { className: 'rv-icon' }));
        row.append(arrow);
      }

      if (item.children !== undefined) {
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

          const subItems = typeof item.children === 'function' ? item.children() : item.children!;
          const childMenu = renderDropdown(subItems, depth + 1);
          childMenu.style.top = `${row.offsetTop}px`;
          childMenu.style.left = `${row.offsetLeft + row.offsetWidth}px`;
          menuEl.append(childMenu);
          activeChildMenu = childMenu;
        };

        row.addEventListener('pointerenter', openChild);
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
      closeAllMenus();
      return;
    }
    closeAllMenus();

    activeMenuBtn = btn;
    btn.classList.add('rv-menu-btn-active');

    const dropdown = renderDropdown(getItems(), 1);
    dropdown.style.left = `${btn.offsetLeft}px`;
    dropdown.style.top = `${btn.offsetTop + btn.offsetHeight}px`;
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

  const getModeItems = (): readonly MenuItemSpec[] => {
    const cur = options.getActiveMode?.() ?? 'replay';
    return [
      {
        label: '单人回放 (Replay)',
        icon: 'mode-single',
        isChecked: cur === 'replay',
        onClick: () => options.onSelectMode?.('replay'),
      },
      {
        label: '自动演示 (Auto)',
        icon: 'mode-auto',
        isChecked: cur === 'auto',
        onClick: () => options.onSelectMode?.('auto'),
      },
      {
        label: '多人比赛 (Match)',
        icon: 'mode-match',
        isChecked: cur === 'match',
        onClick: () => options.onSelectMode?.('match'),
      },
    ];
  };

  const getFileMenuItems = (): readonly MenuItemSpec[] => [
    {
      label: '导入 (Import)',
      children: [
        {
          label: '从链接导入… (From URL)',
          onClick: openUrlModal,
        },
        {
          label: '从比赛房间导入… (Match Room)',
          icon: 'mode-match',
          onClick: () => options.onOpenMatchRoom?.(),
        },
        {
          label: '从本地导入 (Local Files)',
          children: [
            {
              label: '导入 .osu 谱面…',
              onClick: () => osuFileInput.click(),
            },
            {
              label: '导入 .osz 谱面包…',
              onClick: () => oszFileInput.click(),
            },
            {
              label: '导入 .osr 回放…',
              onClick: () => osrFileInput.click(),
            },
          ],
        },
      ],
    },
    { isDivider: true, label: '' },
    {
      label: '重新加载 (Reload)',
      onClick: () => options.onReload?.(),
    },
    {
      label: '退出到选择页 (Exit)',
      onClick: () => options.onExit?.(),
    },
  ];

  const getViewMenuItems = (): readonly MenuItemSpec[] => [
    {
      label: '模式 (Mode)',
      children: getModeItems,
    },
    {
      label: '皮肤 (Skins)',
      children: [
        {
          label: '预设皮肤 (Presets)',
          children: getPresetSkinItems,
        },
        {
          label: '导入皮肤 (.osk / .zip)…',
          onClick: () => oskFileInput.click(),
        },
      ],
    },
    { isDivider: true, label: '' },
    {
      label: '回放设置面板 (Settings)',
      onClick: () => options.onToggleSettings?.(),
    },
    {
      label: '全屏模式 (Toggle Fullscreen)',
      badge: 'F11',
      onClick: () => options.onToggleFullscreen?.(),
    },
  ];

  const addTopButton = (label: string, getItems: () => readonly MenuItemSpec[]): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rv-top-menu-btn';
    btn.textContent = label;

    btn.addEventListener('click', () => openTopMenu(btn, getItems));
    btn.addEventListener('pointerenter', () => {
      if (activeMenuBtn !== null && activeMenuBtn !== btn) {
        openTopMenu(btn, getItems);
      }
    });

    menuBarItems.append(btn);
  };

  addTopButton('文件', getFileMenuItems);
  addTopButton('查看', getViewMenuItems);

  return {
    root,
    userSlot,
    statusSlot,
    updateSkins(): void {
      // Re-render skin list if dropdown is open
    },
    destroy(): void {
      closeAllMenus();
      root.remove();
    },
  };
}

export function menuBarCss(): string {
  return `
/* Top Navigation / Menu Bar (osu!lazer editor style) */
.rv-top-bar {
  flex: 0 0 38px;
  height: 38px;
  background: #253330;
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
}

.rv-menu-left {
  display: flex;
  align-items: stretch;
}

.rv-menu-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: #1c2624;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: #ffffff;
}
.rv-menu-logo-icon {
  color: #4ed9c8;
  display: flex;
  align-items: center;
}
.rv-brand-accent {
  color: #4ed9c8;
}

.rv-menu-items {
  display: flex;
  align-items: stretch;
}

.rv-top-menu-btn {
  background: transparent;
  border: none;
  color: #d0dedc;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 0 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: background 80ms ease, color 80ms ease;
}
.rv-top-menu-btn:hover {
  background: #384a46;
  color: #ffffff;
}
.rv-top-menu-btn.rv-menu-btn-active {
  background: #465c57;
  color: #ffffff;
}

.rv-menu-right {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
}
.rv-menu-status {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  white-space: nowrap;
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

