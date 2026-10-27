// Colour theme: 'system' (follows prefers-color-scheme), 'light' or 'dark'.
// The choice is stored per device in localStorage ('tt.theme') and applied as
// <html data-theme="light|dark"> (no attribute for 'system').
// Demo build: the page may be embedded in a viewer that sets <html data-theme> itself;
// 'system' then follows the viewer's choice instead of removing it.

import { isDemo } from './demo.js';

const STORAGE_KEY = 'tt.theme';
const MODES = ['system', 'light', 'dark'];
const THEME_COLORS = { light: '#ffffff', dark: '#121820' }; // top bar colour (--surface)

const listeners = new Set();
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function readStored() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return MODES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

let mode = readStored();
let hostTheme = null; // data-theme set by an embedding viewer (demo only), 'light' | 'dark' | null
let applied = null; // data-theme value this module set last

/** 'system' | 'light' | 'dark' */
export function getTheme() {
  return mode;
}

/** The theme actually shown: 'light' | 'dark'. */
export function effectiveTheme() {
  if (mode !== 'system') return mode;
  if (hostTheme) return hostTheme;
  return darkQuery?.matches ? 'dark' : 'light';
}

function apply() {
  const root = document.documentElement;
  const value = mode === 'system' ? hostTheme : mode;
  applied = value;
  if (value) root.dataset.theme = value;
  else delete root.dataset.theme;
  // Browser UI colour: both <meta name="theme-color"> carry a media query; a manual
  // choice overrides both so the status bar matches the page.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const media = meta.getAttribute('media') || '';
    const scheme = value ?? (media.includes('dark') ? 'dark' : 'light');
    meta.setAttribute('content', THEME_COLORS[scheme]);
  }
}

function notify() {
  const effective = effectiveTheme();
  for (const fn of [...listeners]) {
    try {
      fn({ mode, effective });
    } catch (err) {
      console.error(err);
    }
  }
}

/** Sets and stores the theme mode. */
export function setTheme(next) {
  if (!MODES.includes(next)) return;
  mode = next;
  try {
    if (mode === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  apply();
  notify();
}

/** Switches between light and dark (explicit choice). */
export function toggleTheme() {
  setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
}

/** Listens to theme changes: fn({ mode, effective }). Returns an unsubscribe function. */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Applies the stored theme (call once at start-up). */
export function initTheme() {
  if (isDemo()) watchHostTheme();
  apply();
  darkQuery?.addEventListener?.('change', () => {
    if (mode === 'system') notify();
  });
}

/** Demo: follows <html data-theme> changes made by an embedding viewer. */
function watchHostTheme() {
  const root = document.documentElement;
  const read = () => (root.dataset.theme === 'light' || root.dataset.theme === 'dark' ? root.dataset.theme : null);
  hostTheme = read();
  if (typeof MutationObserver !== 'function') return;
  new MutationObserver(() => {
    const value = read();
    if (value === applied) return; // our own change
    hostTheme = value;
    apply(); // an explicit choice in the app wins over the viewer's
    notify();
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}

export const THEME_OPTIONS = Object.freeze([
  { value: 'system', label: 'Automático', icon: 'contrast' },
  { value: 'light', label: 'Claro', icon: 'sun' },
  { value: 'dark', label: 'Oscuro', icon: 'moon' },
]);

export const theme = { get: getTheme, set: setTheme, toggle: toggleTheme, effective: effectiveTheme, onChange: onThemeChange, options: THEME_OPTIONS };

export default theme;
