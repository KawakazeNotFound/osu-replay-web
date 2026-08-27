/**
 * Skin selection.
 *
 * The 12 skins the captured page ships are already sitting in `site/skins/`, each with the
 * `index.json` manifest `loadSkinFromDir` expects — so this is a lookup and a cache, not a
 * loader. Reusing them rather than bundling our own also means the two UIs offer the same set.
 *
 * Skins are cached by name for the page's lifetime. Decoding one is hundreds of image and audio
 * files, so re-loading it on every replay would add seconds to each load for no gain; the cost is
 * memory held until reload, which is the same trade the captured page makes.
 */

import { loadSkinFromDir, loadSkin as loadSkinFromZip, type SkinAssets } from '../../src/index.js';

/**
 * Where the skins live. Same path on the deployed Worker and on the dev server, which mounts
 * `site/skins/` there for exactly this reason — a different URL per environment would mean the
 * dev build and the deployed one exercise different code.
 */
const SKIN_BASE = '/skins';

/**
 * The skins the captured page offers, in its own order.
 *
 * Hardcoded rather than discovered: the asset server has no directory listing, so the only way to
 * enumerate them is to already know the names. Kept in sync by hand; a name that no longer exists
 * fails loudly on selection rather than silently loading nothing.
 */
export const SKIN_NAMES = [
  'Ryosume',
  'YUGEN',
  'Default',
  'Rafis',
  'bog',
  'Kamui',
  'UNTITLED',
  'shinchikuskin',
  '4sbet1',
  'R Skin V2.0',
  'bojii',
  'myuka arrows',
  'Skin for CTB',
] as const;

export type SkinName = typeof SKIN_NAMES[number];

/** The default, matching user's custom skin. */
export const DEFAULT_SKIN: SkinName = 'Ryosume';

/**
 * One entry per skin, holding the in-flight promise rather than the resolved value: two loads
 * started before either finishes should share the work instead of racing.
 */
const cache = new Map<string, Promise<SkinAssets>>();
const customSkinNames: string[] = [];

/** URL for a skin directory. Names contain spaces and dots, so each segment is encoded. */
function skinUrl(name: string): string {
  return `${SKIN_BASE}/${encodeURIComponent(name)}`;
}

/**
 * Registers an imported custom skin (e.g. from .osk / .zip).
 */
export function registerCustomSkin(name: string, skin: SkinAssets): void {
  cache.set(name, Promise.resolve(skin));
  if (!customSkinNames.includes(name)) {
    customSkinNames.push(name);
  }
}

/**
 * Decodes and registers an uploaded .osk/.zip custom skin file.
 */
export async function importCustomSkinFile(file: File, audioContext: AudioContext): Promise<string> {
  const buf = await file.arrayBuffer();
  const skin = await loadSkinFromZip(buf, audioContext);
  const name = file.name.replace(/\.(osk|zip)$/i, '');
  registerCustomSkin(name, skin);
  return name;
}

/**
 * Returns all available skins, combining default presets and imported custom skins.
 */
export function getAllSkinNames(): readonly string[] {
  return [...SKIN_NAMES, ...customSkinNames];
}

/**
 * Loads a skin, or returns the cached copy. A failed load is evicted so a retry can succeed —
 * caching the rejection would make one flaky request permanent for the session.
 */
export async function loadSkin(name: string, audioContext: AudioContext): Promise<SkinAssets> {
  const cached = cache.get(name);
  if (cached !== undefined) return await cached;

  const pending = loadSkinFromDir(skinUrl(name), audioContext).catch((err: unknown) => {
    cache.delete(name);
    throw err;
  });
  cache.set(name, pending);
  return await pending;
}

/** Which skins have been loaded already — useful for saying so in a status line. */
export function loadedSkins(): readonly string[] {
  return [...cache.keys()];
}
