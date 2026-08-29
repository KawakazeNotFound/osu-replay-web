/**
 * Lightweight client language detection and translation helper.
 *
 * Supports Chinese (zh) and English (en).
 * Automatically detects client browser locale (navigator.language),
 * with optional localStorage persistence.
 */

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'rv_lang';

export function getLanguage(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {}

  const nav = typeof navigator !== 'undefined'
    ? (navigator.language || (navigator as { userLanguage?: string }).userLanguage || '')
    : '';

  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function setLanguage(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {}
}

export function isZh(): boolean {
  return getLanguage() === 'zh';
}

/**
 * Returns Chinese text if client locale is Chinese, otherwise English.
 */
export function t(zh: string, en: string): string {
  return isZh() ? zh : en;
}
