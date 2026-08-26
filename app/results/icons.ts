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
  | 'mode-single' | 'mode-auto' | 'mode-match' | 'chevron-right';

/**
 * Path data per icon. Filled shapes rather than strokes, so they stay crisp at the small sizes
 * the transport row uses without needing vector-effect hints.
 */
const PATHS: Readonly<Record<IconName, readonly string[]>> = {
  // A five-pointed star, for the star-rating badge.
  star: ['M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z'],
  // A tick on its own, for "this option is the selected one".
  check: ['M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z'],
  // Chevron right arrow for submenus.
  'chevron-right': ['M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z'],
  // Mode icons (Single, Auto, Match).
  'mode-single': [
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
export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', VIEWBOX[name] ?? '0 0 24 24');
  svg.setAttribute('class', options.className ?? 'rv-icon');
  if (options.label !== undefined) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const d of PATHS[name]) {
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
