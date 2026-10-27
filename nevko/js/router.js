// Hash router: '#/util/12?tab=x' -> { name, path: '/util/12', params: { id: '12' }, query: { tab: 'x' } }.
//
// Every history entry is stamped with its position (history.state.ttIdx) so the router
// knows the navigation direction ('push' | 'replace' | 'back' | 'forward' | 'initial'),
// whether there is an in-app page to go back to, and can restore scroll positions.
// The Android back button therefore behaves like the in-app back arrow.
//
// Fallback: when the page cannot change its own location.hash (some embedded, sandboxed
// frames ignore it), the router keeps the location in memory instead: same routes, same
// events, in-app back navigation and hash links (<a href="#/...">) still work.

const routes = [];
const listeners = new Set();
const scrollPositions = new Map(); // history index -> scrollY
const paths = new Map(); // history index -> path (known in this page load)

let current = null;
let index = 0;
let pendingReplace = false;
let started = false;
let defaultPath = '/';
let memoryHash = null; // in-memory location (fallback mode), null = window.location.hash
const memoryStack = []; // fallback mode: hash of every in-app entry, by history index

/** Current hash: the real one, or the in-memory one in fallback mode. */
function currentHash() {
  return memoryHash ?? window.location.hash;
}

function decodedHash(hash) {
  try {
    return decodeURIComponent(String(hash).replace(/^#/, ''));
  } catch {
    return String(hash).replace(/^#/, '');
  }
}

/** Same location, whatever the percent-encoding. */
function sameHash(a, b) {
  return decodedHash(a) === decodedHash(b);
}

/** history.replaceState that never throws (sandboxed frames may refuse it). */
function replaceHistoryState(state) {
  try {
    window.history.replaceState(state, '');
  } catch {
    // Directions fall back to 'push'; navigation keeps working.
  }
}

function historyState() {
  try {
    return window.history.state;
  } catch {
    return null;
  }
}

/** Compiles '/util/:id' into a RegExp with named parameter keys. */
function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      if (segment === '*') {
        keys.push('rest');
        return '(.*)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source || ''}/?$`), keys };
}

/**
 * Matches a path against a pattern ('/admin/utiles/:id'); returns params or null.
 * Parameters are URI-decoded.
 */
export function matchPath(pattern, path) {
  const { regex, keys } = compile(pattern);
  const match = regex.exec(path);
  if (!match) return null;
  const params = {};
  keys.forEach((key, i) => {
    try {
      params[key] = decodeURIComponent(match[i + 1]);
    } catch {
      params[key] = match[i + 1];
    }
  });
  return params;
}

/** Splits a hash ('#/a/b?x=1') into a normalised path and a query object. */
export function parseHash(hash = currentHash()) {
  const raw = String(hash).replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  let path = `/${pathPart.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
  path = path.replace(/\/{2,}/g, '/');
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  return { path, query };
}

function resolve(hash) {
  const { path, query } = parseHash(hash);
  for (const route of routes) {
    const params = matchPath(route.pattern, path);
    if (params) return { name: route.name, pattern: route.pattern, path, params, query };
  }
  return { name: null, pattern: null, path, params: {}, query };
}

/** Builds a hash href: href('/util/12', { q: 'x' }) -> '#/util/12?q=x'. */
export function href(path, query) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  return `#${path}${qs ? `?${qs}` : ''}`;
}

function stampEntry() {
  const state = historyState();
  let direction;
  if (state && typeof state.ttIdx === 'number') {
    direction = state.ttIdx < index ? 'back' : state.ttIdx > index ? 'forward' : 'replace';
    index = state.ttIdx;
  } else {
    if (pendingReplace) direction = 'replace';
    else {
      direction = 'push';
      index += 1;
    }
    replaceHistoryState({ ...(state ?? {}), ttIdx: index });
  }
  pendingReplace = false;
  return direction;
}

function emit(route, previous, direction) {
  for (const fn of [...listeners]) {
    try {
      fn(route, previous, { direction });
    } catch (err) {
      console.error(err);
    }
  }
}

function onHashChange() {
  if (memoryHash !== null) return; // fallback mode: the in-memory location rules
  scrollPositions.set(index, window.scrollY);
  const previous = current;
  const direction = stampEntry();
  current = resolve(window.location.hash);
  paths.set(index, current.path);
  if (!current.name && current.path === '/' && defaultPath !== '/') {
    navigate(defaultPath, { replace: true });
    return;
  }
  emit(current, previous, direction);
}

// ---------------------------------------------------------------------------
// In-memory fallback

/** Switches to the in-memory location (the page ignored a location.hash write). */
function enterMemoryMode() {
  memoryHash = window.location.hash;
  memoryStack.length = 0;
  memoryStack[index] = memoryHash;
}

/** Emits the in-memory location asynchronously, like a hashchange event. */
function emitMemory(direction) {
  setTimeout(() => {
    const previous = current;
    current = resolve(memoryHash);
    paths.set(index, current.path);
    if (!current.name && current.path === '/' && defaultPath !== '/') {
      navigate(defaultPath, { replace: true });
      return;
    }
    emit(current, previous, direction);
  }, 0);
}

function memoryNavigate(target, replace) {
  scrollPositions.set(index, window.scrollY);
  if (!replace) {
    index += 1;
    memoryStack.length = index;
  }
  memoryStack[index] = target;
  memoryHash = target;
  emitMemory(replace ? 'replace' : 'push');
}

function memoryBack() {
  scrollPositions.set(index, window.scrollY);
  index -= 1;
  memoryHash = memoryStack[index] ?? `#${defaultPath}`;
  emitMemory('back');
}

/** Fallback mode: hash links are followed by the router (the frame ignores them). */
function onDocumentClick(event) {
  if (memoryHash === null || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target?.closest?.('a[href^="#"]');
  if (!link || (link.target && link.target !== '_self')) return;
  event.preventDefault();
  const { path, query } = parseHash(link.getAttribute('href'));
  navigate(path, { query });
}

export const router = {
  /** Registers a named route. Patterns: '/util/:id', '/admin/*'. First match wins. */
  define(name, pattern) {
    routes.push({ name, pattern });
    return router;
  },

  /** Path used for an empty hash ('#' or '#/'). */
  setDefault(path) {
    defaultPath = path;
    return router;
  },

  /**
   * Subscribes to route changes: fn(route, previousRoute, { direction }).
   * direction: 'initial' | 'push' | 'replace' | 'back' | 'forward'. Returns an unsubscribe function.
   */
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Starts listening and emits the initial route. */
  start() {
    if (started) return;
    started = true;
    try {
      if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    } catch {
      // Not available in this frame.
    }
    const state = historyState();
    if (state && typeof state.ttIdx === 'number') index = state.ttIdx;
    else replaceHistoryState({ ...(state ?? {}), ttIdx: index });
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('click', onDocumentClick);
    current = resolve(window.location.hash);
    paths.set(index, current.path);
    if (!current.name && current.path === '/' && defaultPath !== '/') {
      navigate(defaultPath, { replace: true });
      return;
    }
    emit(current, null, 'initial');
  },

  /** Current route object. */
  current() {
    return current;
  },

  navigate,

  /**
   * Goes back one entry when the previous page belongs to this app; otherwise
   * replaces the current entry with `fallback` (e.g. after opening a deep link).
   */
  back(fallback = defaultPath) {
    if (index > 0 && memoryHash !== null) memoryBack();
    else if (index > 0) window.history.back();
    else navigate(fallback, { replace: true });
  },

  /** True when there is an in-app entry behind the current one. */
  canGoBack() {
    return index > 0;
  },

  /** Path of the previous entry when known in this page load (null otherwise). */
  previousPath() {
    return index > 0 ? paths.get(index - 1) ?? null : null;
  },

  /** Saved scroll position of the current entry (for back/forward navigation). */
  savedScroll() {
    return scrollPositions.get(index) ?? 0;
  },

  /** Re-emits the current route (e.g. after signing in on the same URL). */
  refresh() {
    if (current) emit(current, current, 'replace');
  },

  href,
  matchPath,
  parseHash,
};

/**
 * Navigates to `path` (optionally with a query object).
 *   navigate('/util/12')                      push
 *   navigate('/entrar', { replace: true })    replace the current entry
 * Navigating to the current URL re-emits the route.
 */
export function navigate(path, { replace = false, query } = {}) {
  const target = href(path, query);
  if (sameHash(currentHash(), target)) {
    router.refresh();
    return;
  }
  if (memoryHash === null) {
    const before = window.location.hash;
    try {
      if (replace) {
        pendingReplace = true;
        // Absolute URL: a <base href> must not turn this into a page load.
        const url = new URL(window.location.href);
        url.hash = target;
        window.location.replace(url.href);
      } else {
        window.location.hash = target;
      }
    } catch {
      // Refused by the frame: handled below.
    }
    if (!sameHash(window.location.hash, before)) return; // the hashchange event renders it
    pendingReplace = false;
    enterMemoryMode();
  }
  memoryNavigate(target, replace);
}

export default router;
