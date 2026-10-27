// Operator session: token, signed-in operator, the list of tools they hold, their pick list
// and the "shared device" option (sign-out after a while without interaction).
//
// The held tools (`store.mine`) are the single source for the Guardar screen and the
// tab badge; they are refreshed after every own action and after every server change.
// The pick list (`store.picks` / `store.pickIds`) works the same way for En lista, the
// marks in Buscar and its badge.

import { api, tokens } from './api.js';
import { persistOperator, store } from './store.js';

const EXPECTATION_MS = 15_000;
const REFRESH_DEBOUNCE_MS = 200;

const lostListeners = new Set();
const expectedRemovals = new Map(); // toolId -> timestamp until which a removal is expected

let inflight = null;
let pendingAgain = false;
let debounceTimer = null;

/** True when an operator token is stored. */
export function isSignedIn() {
  return Boolean(tokens.get(false));
}

/** { id, name } of the signed-in operator, or null. */
export function currentOperator() {
  return store.get().operator;
}

function emptySessionState() {
  return {
    mine: [],
    mineLoaded: false,
    mineError: null,
    inUseCount: 0,
    picks: [],
    pickIds: new Set(),
    picksLoaded: false,
    picksError: null,
    pickCount: 0,
    search: { query: '', result: null, focus: true },
  };
}

/**
 * Stores a new session (POST /api/session result). A previous operator session on
 * this device is closed on the server (best effort).
 */
export function signIn({ token, operator }) {
  const previous = tokens.get(false);
  tokens.set(token, false);
  persistOperator(operator);
  expectedRemovals.clear();
  forgetPickChanges();
  store.set({ operator, ...emptySessionState() });
  if (previous && previous !== token) api.logout(previous).catch(() => {});
  void refreshMine();
  void refreshPicks();
}

/** Forgets the session locally (token, operator, cached lists). */
export function clearSession() {
  tokens.clear(false);
  persistOperator(null);
  expectedRemovals.clear();
  forgetPickChanges();
  store.set({ operator: null, ...emptySessionState() });
}

/** Closes the session on the server and locally. Never throws. */
export async function signOut() {
  const token = tokens.get(false);
  clearSession();
  if (token) {
    try {
      await api.logout(token);
    } catch {
      // Offline or already expired: the local session is gone anyway.
    }
  }
}

/**
 * Marks tools as removed by this device (returned here), so their disappearance from
 * the held list is not reported as "someone else took it".
 */
export function expectRemoval(toolIds) {
  const until = Date.now() + EXPECTATION_MS;
  for (const id of [].concat(toolIds)) expectedRemovals.set(id, until);
}

/** Cancels expectRemoval() for tools that are held again (e.g. after "Deshacer"). */
export function cancelExpectedRemoval(toolIds) {
  for (const id of [].concat(toolIds)) expectedRemovals.delete(id);
}

/**
 * Called with Tool[] when tools disappear from the operator's list because of someone
 * else (transfer to another operator, forced return by the administrator...).
 */
export function onToolsLost(fn) {
  lostListeners.add(fn);
  return () => lostListeners.delete(fn);
}

async function loadMine() {
  // The answer belongs to the token it was asked with (the operator may not be known yet).
  const token = tokens.get(false);
  let result;
  try {
    result = await api.myTools();
  } catch (err) {
    if (!store.get().mineLoaded) store.set({ mineError: err });
    return;
  }
  const state = store.get();
  if (!token || tokens.get(false) !== token) return; // signed out or operator switched meanwhile
  const tools = Array.isArray(result?.tools) ? result.tools : [];

  const now = Date.now();
  for (const [id, until] of expectedRemovals) if (until < now) expectedRemovals.delete(id);

  if (state.mineLoaded) {
    const ids = new Set(tools.map((tool) => tool.id));
    const lost = state.mine.filter((tool) => !ids.has(tool.id) && !expectedRemovals.has(tool.id));
    if (lost.length) {
      for (const fn of [...lostListeners]) {
        try {
          fn(lost);
        } catch (err) {
          console.error(err);
        }
      }
    }
  }
  store.set({ mine: tools, mineLoaded: true, mineError: null, inUseCount: tools.length });
}

/**
 * Reloads the held tools now. Concurrent calls are coalesced: at most one request
 * in flight plus one follow-up. Resolves when the store is up to date.
 */
export function refreshMine() {
  clearTimeout(debounceTimer);
  debounceTimer = null;
  if (!isSignedIn()) return Promise.resolve();
  if (inflight) {
    pendingAgain = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      pendingAgain = false;
      await loadMine();
    } while (pendingAgain && isSignedIn());
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Debounced refreshMine() for bursts of server events. */
export function refreshMineSoon(delay = REFRESH_DEBOUNCE_MS) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void refreshMine(), delay);
}

/** Re-reads the operator (name changes, deactivation -> 401). Never throws. */
export async function refreshMe() {
  if (!isSignedIn()) return;
  const token = tokens.get(false);
  try {
    const { operator, pickCount } = await api.me();
    if (operator && isSignedIn() && tokens.get(false) === token) {
      persistOperator(operator);
      const current = store.get().operator;
      if (!current || current.id !== operator.id || current.name !== operator.name) store.set({ operator });
      // The badge before the list itself has arrived (afterwards the list is the source).
      if (!store.get().picksLoaded && Number.isInteger(pickCount)) store.set({ pickCount });
    }
  } catch {
    // 401 is handled globally (api 'unauthorized'); network errors show the offline banner.
  }
}

// ---------------------------------------------------------------------------
// Pick list ("En lista"): the tools the operator has marked to go and take, zone by zone.
// It belongs to the operator (every device of theirs sees it). `store.picks` is the list as
// the server last sent it; `store.pickIds` also has the marks still on their way to the
// server, so a tapped button changes at once and a list read in between does not undo it.

const pickPending = new Map(); // toolId -> { on: boolean, mark: number }
const pickListeners = new Set();
let pickMark = 0;
let picksVersion = 0; // bumped when the list changes locally: lists read before are stale
let picksInflight = null;
let picksAgain = false;
let picksTimer = null;

function forgetPickChanges() {
  pickPending.clear();
  picksVersion += 1;
  clearTimeout(picksTimer);
  picksTimer = null;
}

/** Publishes the list (optional patch) with the pending marks applied: pickIds, pickCount. */
function publishPicks(patch = {}) {
  const tools = patch.picks ?? store.get().picks;
  const ids = new Set(tools.map((tool) => tool.id));
  for (const [id, { on }] of pickPending) {
    if (on) ids.add(id);
    else ids.delete(id);
  }
  store.set({ ...patch, pickIds: ids, pickCount: ids.size });
}

const heldByOther = (tool) => (tool.holder && !tool.holder.isMe ? tool.holder.operatorId : null);

/** Tells onPickChanges() listeners which listed tools someone else took or left free. */
function notifyPickChanges(before, after) {
  const previous = new Map(before.map((tool) => [tool.id, tool]));
  const taken = [];
  const freed = [];
  for (const tool of after) {
    const old = previous.get(tool.id);
    if (!old) continue;
    const was = heldByOther(old);
    const now = heldByOther(tool);
    if (now !== null && now !== was) taken.push(tool);
    else if (now === null && was !== null && !tool.holder && tool.active !== false) freed.push(tool);
  }
  if (!taken.length && !freed.length) return;
  for (const fn of [...pickListeners]) {
    try {
      fn({ taken, freed });
    } catch (err) {
      console.error(err);
    }
  }
}

function applyPicks(list) {
  const tools = Array.isArray(list) ? list : [];
  const state = store.get();
  if (state.picksLoaded) notifyPickChanges(state.picks, tools);
  publishPicks({ picks: tools, picksLoaded: true, picksError: null });
}

async function loadPicks() {
  const token = tokens.get(false);
  const version = picksVersion;
  let result;
  try {
    result = await api.picklist();
  } catch (err) {
    if (!store.get().picksLoaded && tokens.get(false) === token) store.set({ picksError: err });
    return;
  }
  if (!token || tokens.get(false) !== token) return; // signed out or operator switched meanwhile
  if (version !== picksVersion) {
    picksAgain = true; // the list changed here meanwhile: this answer may be older, read again
    return;
  }
  applyPicks(result?.tools);
}

/** Reloads the pick list now (coalesced like refreshMine). Resolves when the store is up to date. */
export function refreshPicks() {
  clearTimeout(picksTimer);
  picksTimer = null;
  if (!isSignedIn()) return Promise.resolve();
  if (picksInflight) {
    picksAgain = true;
    return picksInflight;
  }
  picksInflight = (async () => {
    do {
      picksAgain = false;
      await loadPicks();
    } while (picksAgain && isSignedIn());
  })().finally(() => {
    picksInflight = null;
  });
  return picksInflight;
}

/** Debounced refreshPicks() for bursts of server events. */
export function refreshPicksSoon(delay = REFRESH_DEBOUNCE_MS) {
  clearTimeout(picksTimer);
  picksTimer = setTimeout(() => void refreshPicks(), delay);
}

/** True while a mark or unmark of this tool is on its way to the server. */
export function isPickPending(toolId) {
  return pickPending.has(toolId);
}

async function changePicks(ids, on, send) {
  const token = tokens.get(false);
  const mark = ++pickMark;
  const settle = () => {
    for (const id of ids) if (pickPending.get(id)?.mark === mark) pickPending.delete(id);
  };
  for (const id of ids) pickPending.set(id, { on, mark });
  publishPicks();
  let result;
  try {
    result = await send();
  } catch (err) {
    if (tokens.get(false) === token) {
      settle();
      publishPicks();
    }
    throw err;
  }
  if (tokens.get(false) === token) {
    settle();
    picksVersion += 1;
    applyPicks(result?.tools);
    // Answers of changes made at the same time may arrive in any order: read the final list.
    if (pickPending.size) refreshPicksSoon();
  }
  return result;
}

/**
 * Marks tools (ids) to be taken. The marks show at once; the list the server answers then
 * replaces store.picks. Resolves with { tools, skipped: [{ toolId, code?, reason }] }
 * (reason 'NOT_FOUND' | 'ALREADY_MINE' | 'TOOL_INACTIVE'); an ApiError undoes the marks.
 */
export function addPicks(toolIds) {
  const ids = [...new Set([].concat(toolIds))];
  return changePicks(ids, true, () => api.addToPicklist(ids));
}

/** Unmarks one tool (same behaviour as addPicks). */
export function removePick(toolId) {
  return changePicks([toolId], false, () => api.removeFromPicklist(toolId));
}

/** Empties the pick list. */
export function clearPicks() {
  const ids = [...store.get().pickIds];
  return changePicks(ids, false, () => api.clearPicklist());
}

/**
 * Drops tools from the local list at once, without a request: the server already took them
 * out (a checkout by this operator removes the tool from their list).
 */
export function forgetPicks(toolIds) {
  const ids = new Set([].concat(toolIds));
  picksVersion += 1; // a list read before the checkout still has them
  const { picks } = store.get();
  if (picks.some((tool) => ids.has(tool.id))) publishPicks({ picks: picks.filter((tool) => !ids.has(tool.id)) });
}

/**
 * Called with { taken: Tool[], freed: Tool[] } when listed tools are taken by another operator
 * (their `holder`) or become free again. Returns an unsubscribe function.
 */
export function onPickChanges(fn) {
  pickListeners.add(fn);
  return () => pickListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Shared device ("Dispositivo compartido", an option of this device kept in localStorage):
// after SHARED_IDLE_MS without interaction the session is closed, so the next operator
// starts from #/entrar instead of acting under someone else's name.

const SHARED_KEY = 'tt.sharedDevice';
export const SHARED_IDLE_MS = 5 * 60_000;
const IDLE_WARNING_MS = 30_000;
const IDLE_CHECK_MS = 1_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

const sharedListeners = new Set();
let sharedFallback = false; // storage unavailable (private mode)

/** True when this device is marked as shared by several operators. */
export function isSharedDevice() {
  try {
    return window.localStorage.getItem(SHARED_KEY) === '1';
  } catch {
    return sharedFallback;
  }
}

export function setSharedDevice(on) {
  sharedFallback = Boolean(on);
  try {
    if (on) window.localStorage.setItem(SHARED_KEY, '1');
    else window.localStorage.removeItem(SHARED_KEY);
  } catch {
    // Storage unavailable: the in-memory value lasts until the page is reloaded.
  }
  for (const fn of [...sharedListeners]) fn(Boolean(on));
}

/** Called with the new value when the shared-device option changes. Returns an unsubscribe function. */
export function onSharedDeviceChange(fn) {
  sharedListeners.add(fn);
  return () => sharedListeners.delete(fn);
}

/**
 * Watches for inactivity: onWarn() IDLE_WARNING_MS before the limit, onActive() when the
 * operator interacts after a warning and onIdle() once `timeout` ms pass without any
 * interaction (the watch then stops). Time spent with the screen off counts. Returns stop().
 */
export function watchIdle({ timeout = SHARED_IDLE_MS, onWarn, onActive, onIdle }) {
  let last = Date.now();
  let warned = false;
  let stopped = false;

  const touch = () => {
    last = Date.now();
    if (warned) {
      warned = false;
      onActive?.();
    }
  };
  const check = () => {
    if (stopped) return;
    const idle = Date.now() - last;
    if (idle >= timeout) {
      stop();
      onIdle();
    } else if (!warned && idle >= timeout - IDLE_WARNING_MS) {
      warned = true;
      onWarn?.();
    }
  };
  const timer = setInterval(check, IDLE_CHECK_MS);
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, touch, { capture: true, passive: true });
  document.addEventListener('visibilitychange', check);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, touch, { capture: true });
    document.removeEventListener('visibilitychange', check);
  }
  return stop;
}
