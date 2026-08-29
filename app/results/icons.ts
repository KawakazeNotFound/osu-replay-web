/**
 * Inline SVG icons.
 *
 * Everything is drawn from paths here rather than using glyphs (`⏸`, `↺`, `⏻`) or an icon font.
 * Glyphs render as full-colour emoji on some platforms and as tofu on others, and neither is
 * something a stylesheet can correct — the shape is up to the user's font stack, not to us.
 * Drawn paths also carry no external asset, so nothing to fetch and nothing to license.
 *
 * Each icon is a 24×24 viewBox using `currentColor`, so size and colour come from CSS.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'skip-start' | 'rewind' | 'step-back' | 'play' | 'pause'
  | 'step-forward' | 'fast-forward' | 'skip-end'
  | 'reset' | 'power' | 'download-check' | 'link' | 'check' | 'star'
  | 'mode-single' | 'mode-std' | 'mode-auto' | 'mode-match' | 'chevron-right' | 'chevron-left'
  | 'settings' | 'home' | 'folder' | 'upload' | 'arrow-left' | 'close'
  | 'bell' | 'clock' | 'trophy' | 'chat' | 'globe' | 'music' | 'code' | 'rss' | 'monitor' | 'warning'
  | 'palette' | 'fullscreen';

/**
 * Path data per icon. Filled shapes rather than strokes, so they stay crisp at the small sizes
 * the transport row uses without needing vector-effect hints.
 */
const PATHS: Readonly<Record<IconName, readonly string[]>> = {
  palette: ['M12 2C6.49 2 2 6.49 2 12c0 4.97 3.66 9.07 8.44 9.87.55.09 1-.34 1-.9v-1.42c0-.55.45-1 1-1h1.56c3.87 0 7-3.13 7-7 0-5.51-4.49-10-10-10zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 8 6.5 8 8 8.67 8 9.5 7.33 11 6.5 11zm3-4C8.67 7 8 6.33 8 5.5S8.67 4 9.5 4s1.5.67 1.5 1.5S10.33 7 9.5 7zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 4 14.5 4s1.5.67 1.5 1.5S15.33 7 14.5 7zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 8 17.5 8s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z'],
  fullscreen: ['M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z'],
  bell: ['M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z'],
  clock: ['M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z'],
  trophy: ['M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 15.9V19H7v2h10v-2h-4v-3.1c1.8-.4 3.23-1.8 3.61-3.6A5.002 5.002 0 0 0 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z'],
  chat: ['M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z'],
  globe: ['M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z'],
  music: ['M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'],
  code: ['M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z'],
  rss: ['M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9zM6.12 15.88c-1.17 0-2.12.95-2.12 2.12s.95 2.12 2.12 2.12 2.12-.95 2.12-2.12-.95-2.12-2.12-2.12z'],
  monitor: ['M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h6l-2 3v1h8v-1l-2-3h6c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z'],
  warning: ['M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'],
  // Close / cross icon
  close: [
    'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  ],
  // Settings gear
  settings: [
    'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  ],
  // Home icon
  home: [
    'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  ],
  // Folder icon
  folder: [
    'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  ],
  // Upload icon
  upload: [
    'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
  ],
  // A left-pointing arrow, for "back".
  'arrow-left': ['M10.4 4.6 3 12l7.4 7.4 1.5-1.5L7 13h14v-2H7l4.9-4.9z'],
  // A five-pointed star, for the star-rating badge.
  star: ['M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z'],
  // A tick on its own, for "this option is the selected one".
  check: ['M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z'],
  // Chevron arrows
  'chevron-right': ['M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z'],
  'chevron-left': ['M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z'],
  // Mode icons (Single, Auto, Match).
  'mode-single': [
    'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  ],
  'mode-std': [
    'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  ],
  'mode-auto': [
    'M19 8h-1V6c0-1.1-.9-2-2-2h-3V2h-2v2H8c-1.1 0-2 .9-2 2v2H5c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 12c.83 0 1.5.67 1.5 1.5S9.83 15 9 15s-1.5-.67-1.5-1.5.67-1.5 1.5-1.5zm6 0c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5-1.5-.67-1.5-1.5.67-1.5 1.5-1.5zm-8 6v-1.5h10V18H7z',
  ],
  'mode-match': [
    'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  ],
  // Two interlocking chain links.
  link: [
    'M7.5 14.5a3.5 3.5 0 0 1 0-4.95l2.83-2.83a3.5 3.5 0 0 1 4.95 0l.7.7-1.41 1.42-.7-.7a1.5 1.5 0 0 0-2.13 0L8.91 11a1.5 1.5 0 0 0 0 2.12l.71.71-1.42 1.42-.7-.75z',
    'M16.5 9.5a3.5 3.5 0 0 1 0 4.95l-2.83 2.83a3.5 3.5 0 0 1-4.95 0l-.7-.7 1.41-1.42.7.7a1.5 1.5 0 0 0 2.13 0l2.83-2.83a1.5 1.5 0 0 0 0-2.12l-.71-.71 1.42-1.42.7.75z',
    'M9.17 14.83l5.66-5.66 1.41 1.41-5.66 5.66z',
  ],
  // |◀◀ — a bar plus two triangles.
  'skip-start': [
    'M5 5h2.2v14H5z',
    'M20 5.4v13.2L12.4 12z',
    'M12.2 5.4v13.2L4.6 12z',
  ],
  // ◀◀
  rewind: [
    'M12.4 5.4v13.2L4.8 12z',
    'M20 5.4v13.2L12.4 12z',
  ],
  // |◀
  'step-back': [
    'M6 5h2.2v14H6z',
    'M19 5.4v13.2L9.6 12z',
  ],
  play: ['M7.5 4.8v14.4L19.5 12z'],
  pause: ['M7 5h3.4v14H7z', 'M13.6 5h3.4v14h-3.4z'],
  // ▶|
  'step-forward': [
    'M15.8 5h2.2v14h-2.2z',
    'M5 5.4v13.2L14.4 12z',
  ],
  // ▶▶
  'fast-forward': [
    'M4 5.4v13.2L11.6 12z',
    'M11.6 5.4v13.2L19.2 12z',
  ],
  // ▶▶| — two triangles plus a bar.
  'skip-end': [
    'M16.8 5H19v14h-2.2z',
    'M4 5.4v13.2L11.6 12z',
    'M11.8 5.4v13.2L19.4 12z',
  ],
  // A circular arrow, anticlockwise, with an arrowhead at the top-left.
  reset: [
    'M12 5.2a6.8 6.8 0 1 1-6.8 6.8h2a4.8 4.8 0 1 0 4.8-4.8z',
    'M12.6 3.1 8.9 5.9l3.7 2.8z',
  ],
  // A power symbol: broken ring plus a vertical stem.
  power: [
    'M11 3.6h2v7.6h-2z',
    'M7.4 5.9 8.8 7.4a5.6 5.6 0 1 0 6.4 0l1.4-1.5a7.6 7.6 0 1 1-9.2 0z',
  ],
  // A download tray beside a tick, as one unit — osu!'s "the replay is here" affordance. Wider
  // than the others, hence its own viewBox below.
  'download-check': [
    'M11 3.2h2v6.9h-2z',
    'M12 13.4 7.7 8.6h8.6z',
    'M4.4 15.4h4.1l1.2 2h4.6l1.2-2h4.1v4.3a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1z',
    'M22 16.2 17.8 12l-1.4 1.4L22 19 34 7l-1.4-1.4z',
  ],
};

/** Icons that are not square. Everything else uses the 24×24 default. */
const VIEWBOX: Readonly<Partial<Record<IconName, string>>> = {
  'download-check': '0 0 38 24',
};

/** Icons whose shape reads better mirrored than drawn twice. */
export interface IconOptions {
  /** Extra class on the `<svg>`, for sizing from CSS. */
  readonly className?: string;
  /** Accessible label; omit for icons sitting beside their own text. */
  readonly label?: string;
}

/** Builds one icon. Inherits colour via `currentColor` and size via CSS. */
export function icon(name: IconName | string, options: IconOptions = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const viewBoxStr = (VIEWBOX as Record<string, string>)[name] ?? '0 0 24 24';
  svg.setAttribute('viewBox', viewBoxStr);
  svg.setAttribute('class', options.className ?? 'rv-icon');
  if (options.label !== undefined) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const paths = (PATHS as Record<string, readonly string[]>)[name] ?? [];
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

/** Baseline sizing for icons, so each consumer does not restate it. */
export function iconCss(): string {
  return `
.rv-icon { width: 1em; height: 1em; display: block; flex: 0 0 auto; }
/* Non-square icons take their width from the aspect ratio instead of the em box. */
.rv-icon-wide { width: auto; height: 1em; }
`;
}
