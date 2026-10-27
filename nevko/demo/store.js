// State of the demonstration backend, in one of two modes (initStore() picks it once per page):
//
//   shared  The artifact's `db` capability answered (shared.js): the state lives in documents
//           shared by every device where the published page is open, so the admin on the
//           computer and the operators on their phones use the same data live. The state is
//           kept in memory, changed under a lease (beginChange()) and mirrored to localStorage,
//           so a later visit without `db` still has recent data.
//   local   No `db` (a plain copy of the page, a viewer without the capability, or a failure):
//           the seed of seed.js, kept in memory and saved to localStorage, per device. Storage
//           may be missing or throw (private mode, sandboxed frames): the demo then works in
//           memory until the page closes. Several tabs share the saved state: a tab reloads it
//           when another one saved a newer revision.
//
// A device's own local data (from before sharing) seeds the shared data when it does not exist
// yet; otherwise it is kept aside (tt.demo.device) and can be uploaded from Ajustes.

import { codeKey, codeLoose, codeNorm, textNorm } from '../lib/normalize.js';
import { STATE_VERSION, createEmptyState, createSeedState, migrateState } from './seed.js';
import { SharedSync, fingerprint, openDb, plainState, sharedError, sharedFailureMessage } from './shared.js';

const STATE_KEY = 'tt.demo.state';
const REV_KEY = 'tt.demo.rev';
/** 'shared' while tt.demo.state mirrors the shared data; 'local' (or absent) for this device's own data. */
const ORIGIN_KEY = 'tt.demo.origin';
/** { savedAt, state }: this device's own data from before it joined the shared data. */
const DEVICE_KEY = 'tt.demo.device';
/** sessionStorage: a notice to show after the next reload. */
const NOTICE_KEY = 'tt.demo.notice';
/** Keys of the app itself that belong to the demo data (sessions): cleared on reset. */
const APP_SESSION_KEYS = ['tt.token', 'tt.adminToken', 'tt.operator'];
const START_TIMEOUT_MS = 10_000;
const NOTICE_DELAY_MS = 1200;

let state = null;
let rev = 0;
let loadedOlder = false; // the last state read from localStorage was of an older version (migrated)
let sync = null; // SharedSync while the shared mode is on
let initPromise = null;
const remoteListeners = new Set();
const modeListeners = new Set();

function storageOf(kind) {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function readKey(key, kind = 'local') {
  try {
    return storageOf(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeKey(key, value, kind = 'local') {
  try {
    const storage = storageOf(kind);
    if (!storage) return false;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false; // unavailable or full: the state stays in memory
  }
}

/** Derived search columns of a tool (code_key, code_norm, code_loose, *_norm). */
export function withSearchKeys(tool) {
  tool.codeKey = codeKey(tool.code);
  tool.codeNorm = codeNorm(tool.code);
  tool.codeLoose = codeLoose(tool.code);
  tool.locationNorm = textNorm(tool.location);
  tool.descriptionNorm = textNorm(tool.description);
  return tool;
}

function hydrate(raw) {
  raw.tools.forEach(withSearchKeys);
  return raw;
}

function serialize(current) {
  return {
    ...current,
    tools: current.tools.map(({ id, code, location, description, active, createdAt, updatedAt }) => ({
      id,
      code,
      location,
      description,
      active,
      createdAt,
      updatedAt,
    })),
  };
}

function isValid(raw) {
  return Boolean(
    raw &&
      raw.version === STATE_VERSION &&
      ['tools', 'operators', 'checkouts', 'sessions', 'imports', 'picklist'].every((key) => Array.isArray(raw[key])) &&
      raw.seq &&
      typeof raw.adminPin === 'string',
  );
}

/** A saved state, migrated when it is of an older version (migrateState keeps every record). */
function parseState(text) {
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    const current = migrateState(raw);
    if (!isValid(current)) return null;
    loadedOlder = current !== raw;
    return current;
  } catch {
    return null;
  }
}

function loadStored() {
  loadedOlder = false;
  const raw = parseState(readKey(STATE_KEY));
  return raw ? hydrate(raw) : null;
}

function storedRev() {
  return Number(readKey(REV_KEY)) || 0;
}

/** Saves the state to localStorage; `origin` says whether it is a mirror of the shared data. */
function persistLocal(origin) {
  if (!state) return;
  rev = Math.max(rev, storedRev()) + 1;
  if (writeKey(STATE_KEY, JSON.stringify(serialize(state)))) {
    writeKey(REV_KEY, String(rev));
    writeKey(ORIGIN_KEY, origin);
  }
}

// ---------------------------------------------------------------------------
// Notices (toasts of the app)

function showNotice(message, delay = 0) {
  if (!message) return;
  setTimeout(() => {
    import('../js/ui.js')
      .then((ui) => ui.toast(message, { type: 'error', duration: 0 }))
      .catch(() => {
        // the app could not load its UI module: nothing else to show it with
      });
  }, delay);
}

function rememberNotice(message) {
  writeKey(NOTICE_KEY, message, 'session');
}

function showRememberedNotice() {
  const message = readKey(NOTICE_KEY, 'session');
  if (!message) return;
  writeKey(NOTICE_KEY, null, 'session');
  showNotice(message, NOTICE_DELAY_MS);
}

function localNotice(err) {
  if (err?.code === 'newer_version') {
    return 'Hay una versión más reciente de la demostración abierta en otro dispositivo. Recarga esta página para usarla; mientras tanto, los cambios se guardan solo en este dispositivo.';
  }
  return `${sharedFailureMessage(err)} Desde ahora, los cambios se guardan solo en este dispositivo. Recarga la página para volver a compartirlos.`;
}

// ---------------------------------------------------------------------------
// Modes

/** 'shared' (data shared between devices) or 'local' (this device only). */
export function storeMode() {
  return sync ? 'shared' : 'local';
}

/** fn(mode) when the shared mode ends during the visit. Returns an unsubscribe function. */
export function onModeChange(fn) {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

/** fn() when another device changed the shared data (the whole state may be different). */
export function onRemoteChange(fn) {
  remoteListeners.add(fn);
  return () => remoteListeners.delete(fn);
}

function emit(listeners, ...args) {
  for (const fn of [...listeners]) {
    try {
      fn(...args);
    } catch (err) {
      console.error(err);
    }
  }
}

/** The shared data failed: the demo goes on with the same state, saved on this device only. */
function goLocal(err) {
  if (!sync) return;
  sync = null;
  persistLocal('local');
  emit(modeListeners, 'local');
  showNotice(localNotice(err));
}

function connect(ns) {
  const candidate = new SharedSync(ns, {
    getState: () => state,
    setState(plain, { remote }) {
      if (sync !== candidate) return;
      state = hydrate(plain);
      persistLocal('shared');
      if (remote) emit(remoteListeners);
    },
    onFatal(err) {
      if (sync === candidate) goLocal(err);
    },
  });
  return candidate;
}

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(sharedError('unavailable', 'timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Keeps this device's own data aside (it can be uploaded later from Ajustes). */
function keepDeviceCopy(own) {
  writeKey(DEVICE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), state: serialize(own) }));
}

function readDeviceCopy() {
  const text = readKey(DEVICE_KEY);
  if (!text) return null;
  try {
    const copy = JSON.parse(text);
    const current = migrateState(copy?.state);
    return isValid(current) ? { ...copy, state: current } : null;
  } catch {
    return null;
  }
}

/**
 * Loads the state: shared when the viewer serves `db` (waits for it up to ~4 s, then for the
 * shared data), otherwise from this device. Call once before the API is used.
 */
export function initStore() {
  initPromise ??= (async () => {
    const local = loadStored();
    const localWasOlder = loadedOlder;
    const origin = readKey(ORIGIN_KEY);
    const ns = await openDb();
    if (ns) {
      const candidate = connect(ns);
      try {
        const result = await withTimeout(candidate.start({ localState: local ? serialize(local) : null }), START_TIMEOUT_MS);
        sync = candidate;
        state = hydrate(result.state);
        // This device's own data (not a mirror) that differs from the shared data: keep it aside.
        if (local && origin !== 'shared' && !result.seededFromLocal && fingerprint(local) !== fingerprint(state)) {
          keepDeviceCopy(local);
        }
        rev = storedRev();
        persistLocal('shared');
        showRememberedNotice();
        return;
      } catch (err) {
        candidate.stop();
        showNotice(localNotice(err), NOTICE_DELAY_MS);
      }
    }
    state = local;
    rev = storedRev();
    if (!state) {
      state = hydrate(createSeedState());
      save();
    } else if (localWasOlder) {
      save(); // writes the migrated state back at the current version
    }
    showRememberedNotice();
  })();
  return initPromise;
}

// ---------------------------------------------------------------------------
// State access (backend.js)

/** Current state (local mode: reloaded when another tab saved a newer one). */
export function db() {
  if (sync) return state;
  if (state) {
    const stored = storedRev();
    if (stored && stored !== rev) {
      const fresh = loadStored();
      if (fresh) {
        state = fresh;
        rev = stored;
      }
    }
    return state;
  }
  state = loadStored();
  rev = storedRev();
  if (!state) {
    state = hydrate(createSeedState());
    save();
  }
  return state;
}

/** Saves the state after a change (local mode; the shared mode writes when the change ends). */
export function save() {
  if (sync) return;
  persistLocal('local');
}

/**
 * Starts a change of the state. Shared mode: waits for the lease and for the latest shared
 * data. Resolves end(), to call once the change is applied in memory: it saves the change
 * (the shared write goes on in the background, in order).
 */
export async function beginChange() {
  if (!sync) return async () => {};
  const current = sync;
  const end = await current.begin();
  return async () => {
    if (sync === current) persistLocal('shared');
    await end();
  };
}

/** State without tools, loans, lists or imports; operators, sessions and admin PIN stay. */
function emptiedState(current) {
  const base = createEmptyState();
  if (!current) return base;
  const kept = plainState(current);
  return {
    ...base,
    adminPin: kept.adminPin,
    seq: { ...base.seq, operator: kept.seq.operator },
    operators: kept.operators,
    sessions: kept.sessions,
  };
}

/**
 * Discards the data: new sample data and no sessions, or (empty) no tools, loans, lists or
 * imports. Shared mode: on every device. Resolves false when the shared data could not be
 * changed (the change then applies on this device only).
 */
export async function resetData({ empty = false } = {}) {
  const fresh = empty ? emptiedState(db()) : createSeedState();
  if (!empty) for (const key of APP_SESSION_KEYS) writeKey(key, null);
  let done = true;
  if (sync) {
    done = await sync.replaceAll(fresh);
    if (done) return true;
    // The shared mode ended (goLocal): apply it here and explain after the reload.
    rememberNotice(
      `No se ha podido ${empty ? 'vaciar el catálogo' : 'restablecer la demostración'} en todos tus dispositivos. ${sharedFailureMessage(null)} Inténtalo de nuevo.`,
    );
  }
  state = hydrate(fresh);
  save();
  return done;
}

/** Summary of the data this device had before sharing (shared mode), or null. */
export function deviceCopyInfo() {
  if (!sync) return null;
  const copy = readDeviceCopy();
  if (!copy) return null;
  const { operators, tools, checkouts } = copy.state;
  return {
    savedAt: copy.savedAt ?? null,
    operators: operators.filter((op) => op.active === 1).length,
    tools: tools.filter((tool) => tool.active === 1).length,
    inUse: checkouts.filter((c) => c.returnedAt === null).length,
  };
}

/** Replaces the shared data with this device's own copy. Resolves true when done. */
export async function uploadDeviceCopy() {
  const copy = readDeviceCopy();
  if (!copy || !sync) return false;
  const next = plainState(copy.state);
  // This device's admin session stays valid (the upload is made from Ajustes).
  const adminToken = readKey('tt.adminToken');
  const session = db().sessions.find((s) => s.kind === 'admin' && s.token === adminToken);
  if (session && !next.sessions.some((s) => s.token === adminToken)) next.sessions.push({ ...session });
  if (!(await sync.replaceAll(next))) return false;
  writeKey(DEVICE_KEY, null);
  return true;
}
