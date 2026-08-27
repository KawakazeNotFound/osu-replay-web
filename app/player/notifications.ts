/**
 * osu!lazer accurate toast notification system.
 *
 * Implements:
 * - Fixed top-right non-linear slide-in animation (OutQuint).
 * - Initial full-body bright flash transition fading to normal slate purple.
 * - Icon states: Progress (smooth SVG ring spinner), Success (white circular badge with check),
 *   Error (red circular badge with warning/cross), Info.
 * - Automatic sound triggering via uiSounds ('default', 'done', 'error').
 * - Stackable layout with auto-dismiss timers, hover pause, and click to dismiss.
 */

import { uiSounds } from './uiSounds.js';

export type NotificationType = 'info' | 'success' | 'error' | 'progress';

export interface NotificationOptions {
  readonly title?: string;
  readonly type?: NotificationType;
  readonly duration?: number; // ms, default 3800 (null for progress)
  readonly onClick?: () => void;
  readonly onDismiss?: () => void;
}

export interface NotificationHandle {
  update(message: string, options?: { type?: NotificationType; title?: string; duration?: number }): void;
  dismiss(): void;
}

const ICONS: Record<NotificationType, string> = {
  progress: `
    <svg viewBox="0 0 24 24" width="22" height="22" class="rv-notif-spinner">
      <circle cx="12" cy="12" r="9" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2.5" />
      <path d="M12 3 A 9 9 0 0 1 21 12" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  `,
  success: `
    <svg viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="10" fill="#ffffff" />
      <path d="M7.5 12.2l3.2 3.2L16.8 9" fill="none" stroke="#221e2c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `,
  info: `
    <svg viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="10" fill="#ffffff" />
      <path d="M7.5 12.2l3.2 3.2L16.8 9" fill="none" stroke="#221e2c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `,
  error: `
    <svg viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="10" fill="#ed4264" />
      <path d="M12 7.5v5M12 16v.5" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  `,
};

const DISMISS_ICON = `
  <svg viewBox="0 0 24 24" width="16" height="16" class="rv-notif-dismiss-icon">
    <path d="M6 12.5l4 4L18 8.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

let containerElement: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (!containerElement || !document.body.contains(containerElement)) {
    containerElement = document.createElement('div');
    containerElement.className = 'rv-notifications-container';
    document.body.append(containerElement);
  }
  return containerElement;
}

export function notify(message: string, options?: NotificationOptions): NotificationHandle {
  const container = ensureContainer();
  let type: NotificationType = options?.type ?? 'info';
  let duration = options?.duration !== undefined
    ? options.duration
    : (type === 'progress' ? 0 : (type === 'error' ? 5000 : 3800));

  // Play corresponding sound effect
  if (type === 'success') {
    uiSounds.playNotification('done');
  } else if (type === 'error') {
    uiSounds.playNotification('error');
  } else {
    uiSounds.playNotification('default');
  }

  const card = document.createElement('div');
  card.className = `rv-notification rv-notif-${type} rv-notif-enter`;

  // Flash highlight layer
  const flash = document.createElement('div');
  flash.className = 'rv-notif-flash';

  // Left icon badge
  const iconBox = document.createElement('div');
  iconBox.className = 'rv-notif-icon-box';
  iconBox.innerHTML = ICONS[type];

  // Middle content
  const content = document.createElement('div');
  content.className = 'rv-notif-content';

  if (options?.title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'rv-notif-title';
    titleEl.textContent = options.title;
    content.append(titleEl);
  }

  const textEl = document.createElement('div');
  textEl.className = 'rv-notif-text';
  textEl.textContent = message;
  content.append(textEl);

  // Right dismiss icon
  const dismissBox = document.createElement('div');
  dismissBox.className = 'rv-notif-dismiss';
  dismissBox.innerHTML = DISMISS_ICON;

  card.append(flash, iconBox, content, dismissBox);
  container.append(card);

  uiSounds.attachHoverClick(card, { hover: 'default', click: false });

  let isDismissed = false;
  let dismissTimer: number | null = null;
  let remainingMs = duration;
  let startTime = Date.now();

  const startDismissTimer = (ms: number) => {
    if (ms <= 0) return;
    if (dismissTimer !== null) window.clearTimeout(dismissTimer);
    startTime = Date.now();
    remainingMs = ms;
    dismissTimer = window.setTimeout(() => {
      dismiss();
    }, ms);
  };

  const pauseTimer = () => {
    if (dismissTimer !== null) {
      window.clearTimeout(dismissTimer);
      dismissTimer = null;
      remainingMs -= Date.now() - startTime;
    }
  };

  const resumeTimer = () => {
    if (duration > 0 && remainingMs > 0) {
      startDismissTimer(remainingMs);
    }
  };

  card.addEventListener('pointerenter', pauseTimer);
  card.addEventListener('pointerleave', resumeTimer);

  const dismiss = () => {
    if (isDismissed) return;
    isDismissed = true;
    if (dismissTimer !== null) {
      window.clearTimeout(dismissTimer);
      dismissTimer = null;
    }

    card.classList.remove('rv-notif-enter');
    card.classList.add('rv-notif-exit');

    options?.onDismiss?.();

    setTimeout(() => {
      card.remove();
      if (container.children.length === 0) {
        container.remove();
        containerElement = null;
      }
    }, 320);
  };

  card.addEventListener('click', () => {
    uiSounds.playClick('default');
    options?.onClick?.();
    dismiss();
  });

  if (duration > 0) {
    startDismissTimer(duration);
  }

  return {
    update(newMsg: string, newOpts?: { type?: NotificationType; title?: string; duration?: number }): void {
      if (isDismissed) return;

      if (newOpts?.type && newOpts.type !== type) {
        type = newOpts.type;
        card.className = `rv-notification rv-notif-${type}`;
        iconBox.innerHTML = ICONS[type];

        // Trigger flash layer again on state transition (e.g. from loading to done)
        flash.remove();
        card.prepend(flash);

        if (type === 'success') {
          uiSounds.playNotification('done');
        } else if (type === 'error') {
          uiSounds.playNotification('error');
        }
      }

      if (newOpts?.title !== undefined) {
        let titleEl = content.querySelector('.rv-notif-title') as HTMLElement | null;
        if (!titleEl && newOpts.title) {
          titleEl = document.createElement('div');
          titleEl.className = 'rv-notif-title';
          content.prepend(titleEl);
        }
        if (titleEl) {
          if (newOpts.title) titleEl.textContent = newOpts.title;
          else titleEl.remove();
        }
      }

      textEl.textContent = newMsg;

      if (newOpts?.duration !== undefined) {
        duration = newOpts.duration;
      } else if (type === 'success' || type === 'info') {
        duration = 3800;
      } else if (type === 'error') {
        duration = 5000;
      }

      if (duration > 0) {
        startDismissTimer(duration);
      }
    },
    dismiss,
  };
}

notify.info = (msg: string, opts?: Omit<NotificationOptions, 'type'>) =>
  notify(msg, { ...opts, type: 'info' });

notify.success = (msg: string, opts?: Omit<NotificationOptions, 'type'>) =>
  notify(msg, { ...opts, type: 'success' });

notify.error = (msg: string, opts?: Omit<NotificationOptions, 'type'>) =>
  notify(msg, { ...opts, type: 'error' });

notify.progress = (msg: string, opts?: Omit<NotificationOptions, 'type'>) =>
  notify(msg, { ...opts, type: 'progress' });

export function notificationsCss(): string {
  return `
/* Toast Notifications Overlay (osu!lazer accurate) */
.rv-notifications-container {
  position: fixed;
  top: 46px;
  right: 16px;
  z-index: 99999;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
  max-width: 420px;
  width: calc(100vw - 32px);
  user-select: none;
}

.rv-notification {
  pointer-events: auto;
  position: relative;
  display: flex;
  align-items: stretch;
  min-height: 48px;
  max-width: 100%;
  border-radius: 6px;
  overflow: hidden;
  background: #2e2838;
  color: #ffffff;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.3);
  font-family: "Torus", "Quicksand", system-ui, -apple-system, sans-serif;
  font-size: 13px;
  cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease;
  transform-origin: right center;
}

.rv-notification:hover {
  transform: translateY(-1px) scale(1.01);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
}

.rv-notif-error {
  background: #3b2029;
}

.rv-notif-success {
  background: #262c36;
}

/* Flash highlight animation */
.rv-notif-flash {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.48);
  pointer-events: none;
  border-radius: 6px;
  animation: rv-notif-flash-fade 800ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

@keyframes rv-notif-flash-fade {
  0% { opacity: 1; }
  100% { opacity: 0; }
}

/* Non-linear entrance animation (OutQuint push from right) */
.rv-notif-enter {
  animation: rv-notif-slide-in 420ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes rv-notif-slide-in {
  0% {
    transform: translateX(115%);
    opacity: 0.2;
  }
  60% {
    opacity: 1;
  }
  100% {
    transform: translateX(0);
    opacity: 1;
  }
}

/* Dismiss slide out animation */
.rv-notif-exit {
  animation: rv-notif-slide-out 280ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes rv-notif-slide-out {
  0% {
    transform: translateX(0);
    opacity: 1;
    max-height: 100px;
    margin-bottom: 0;
  }
  100% {
    transform: translateX(115%);
    opacity: 0;
    max-height: 0;
    margin-bottom: -8px;
    padding-top: 0;
    padding-bottom: 0;
  }
}

/* Left Icon column */
.rv-notif-icon-box {
  width: 48px;
  flex-shrink: 0;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
}

.rv-notif-error .rv-notif-icon-box {
  background: rgba(0, 0, 0, 0.35);
}

/* Rotating spinner ring */
.rv-notif-spinner {
  animation: rv-notif-spin 900ms linear infinite;
  transform-origin: center center;
}

@keyframes rv-notif-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Middle Content */
.rv-notif-content {
  flex: 1 1 auto;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  line-height: 1.35;
  font-weight: 500;
  word-break: break-word;
}

.rv-notif-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.65);
}

.rv-notif-text {
  color: #ffffff;
}

/* Right dismiss button */
.rv-notif-dismiss {
  width: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.35);
  transition: color 120ms ease, transform 120ms ease;
}

.rv-notification:hover .rv-notif-dismiss {
  color: rgba(255, 255, 255, 0.85);
}
`;
}
