// HTTP client for the Nevko API (SPEC §4), connectivity tracking and the
// real-time channel (SSE, SPEC §6).
//
//   import { api, ApiError } from './api.js';
//   const { tools } = await api.search('UT-12');
//   const summary = await api.request('GET', '/admin/summary', { admin: true });
//
// Errors are always ApiError { status, code, message, data }:
//   status 0 + code 'NETWORK' | 'TIMEOUT' | 'ABORTED' when there was no HTTP response.

const TOKEN_KEYS = Object.freeze({ operator: 'tt.token', admin: 'tt.adminToken' });
const DEFAULT_TIMEOUT_MS = 20_000;
const PROBE_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 4_000;
const RESYNC_DEBOUNCE_MS = 250;
const HIDDEN_RESYNC_MS = 10_000;
const SSE_RETRY_MIN_MS = 2_000;
const SSE_RETRY_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// Error type

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status (0 when there was no response)
   * @param {string} code machine readable code, e.g. 'HELD_BY_OTHER'
   * @param {string} message message in Spanish, ready to show to the user
   * @param {object} [data] extra fields of the error body (e.g. { holder }, { retryAfter }, { attemptsLeft })
   */
  constructor(status, code, message, data = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }

  /** True when the server could not be reached (network down, server stopped, timeout). */
  get isNetwork() {
    return this.status === 0 && this.code !== 'ABORTED';
  }

  get isAborted() {
    return this.code === 'ABORTED';
  }
}

const FALLBACK_MESSAGES = {
  400: 'La petición no es válida.',
  401: 'Tu sesión ha caducado. Vuelve a identificarte.',
  403: 'No tienes permiso para hacer esto.',
  404: 'No se ha encontrado lo que buscabas.',
  409: 'La operación entra en conflicto con otro cambio. Actualiza e inténtalo de nuevo.',
  413: 'El archivo es demasiado grande.',
  415: 'Tipo de archivo no admitido.',
  422: 'No se ha podido procesar el contenido.',
  429: 'Demasiados intentos. Espera un momento.',
  500: 'Error interno del servidor. Inténtalo de nuevo.',
  503: 'El servidor no está disponible en este momento.',
};

async function errorFromResponse(res) {
  let body = null;
  try {
    if ((res.headers.get('content-type') || '').includes('json')) body = await res.json();
  } catch {
    body = null;
  }
  const { code, message, ...data } = body?.error ?? {};
  const retryHeader = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  if (data.retryAfter === undefined && Number.isFinite(retryHeader)) data.retryAfter = retryHeader;
  return new ApiError(
    res.status,
    code || `HTTP_${res.status}`,
    message || FALLBACK_MESSAGES[res.status] || `Error ${res.status} del servidor.`,
    data,
  );
}

// ---------------------------------------------------------------------------
// Small event emitter

const listeners = { unauthorized: new Set(), connectivity: new Set() };

function emit(event, payload) {
  for (const fn of [...listeners[event]]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err);
    }
  }
}

/**
 * Subscribes to client events:
 *  - 'unauthorized' ({ admin: boolean, error: ApiError }) a request with a token got 401
 *    (the token has already been removed from storage).
 *  - 'connectivity' (online: boolean) the server became reachable / unreachable.
 * Returns an unsubscribe function.
 */
export function on(event, fn) {
  if (!listeners[event]) throw new Error(`api.on(): evento desconocido «${event}»`);
  listeners[event].add(fn);
  return () => listeners[event].delete(fn);
}

// ---------------------------------------------------------------------------
// Tokens (localStorage, with an in-memory fallback when storage is unavailable)

const memoryStore = new Map();

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    if (value === null || value === undefined) memoryStore.delete(key);
    else memoryStore.set(key, value);
  }
}

export const tokens = {
  /** Operator token ('tt.token') or admin token ('tt.adminToken'). */
  get(admin = false) {
    return storageGet(admin ? TOKEN_KEYS.admin : TOKEN_KEYS.operator);
  },
  set(value, admin = false) {
    storageSet(admin ? TOKEN_KEYS.admin : TOKEN_KEYS.operator, value || null);
  },
  clear(admin = false) {
    storageSet(admin ? TOKEN_KEYS.admin : TOKEN_KEYS.operator, null);
  },
};

// ---------------------------------------------------------------------------
// Connectivity

let online = true;
let probeTimer = null;
let probing = false;

export function isOnline() {
  return online;
}

function setOnline(value) {
  if (value === online) return;
  online = value;
  if (online) {
    stopProbe();
    ensureStream();
    scheduleResync();
  } else {
    startProbe();
  }
  emit('connectivity', online);
}

function startProbe() {
  if (probeTimer) return;
  probeTimer = setInterval(() => void checkConnection(), PROBE_INTERVAL_MS);
}

function stopProbe() {
  clearInterval(probeTimer);
  probeTimer = null;
}

/** Pings /api/health; updates the online state. Resolves to true when reachable. */
export async function checkConnection() {
  if (probing) return online;
  probing = true;
  try {
    await request('GET', '/health', { auth: false, timeout: PROBE_TIMEOUT_MS, probe: true });
    setOnline(true);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) setOnline(false);
    else setOnline(true); // got an HTTP answer: the server is there
    return online;
  } finally {
    probing = false;
  }
}

window.addEventListener('online', () => void checkConnection());
window.addEventListener('offline', () => setOnline(false));

// ---------------------------------------------------------------------------
// Requests

function isRawBody(body) {
  return (
    typeof body === 'string' ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof FormData ||
    body instanceof URLSearchParams
  );
}

function buildUrl(path, query) {
  const clean = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return clean;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${clean}?${qs}` : clean;
}

/**
 * Performs an API request.
 * @param {string} method 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
 * @param {string} path relative to /api (e.g. '/tools/search'); a leading '/api/' is also accepted
 * @param {object} [options]
 * @param {*} [options.body] plain object -> JSON; string/Blob/File/ArrayBuffer/FormData are sent as is
 * @param {boolean} [options.raw=false] force sending `body` as is (set Content-Type in `headers`)
 * @param {object} [options.headers] extra request headers
 * @param {boolean} [options.admin=false] use the admin token instead of the operator token
 * @param {boolean} [options.auth=true] attach the token (false for public endpoints)
 * @param {string} [options.token] explicit token (overrides the stored one)
 * @param {object} [options.query] query string parameters (empty values are skipped)
 * @param {AbortSignal} [options.signal] cancels the request (rejects with code 'ABORTED')
 * @param {number} [options.timeout=20000] ms before rejecting with code 'TIMEOUT' (0 = none)
 * @param {'json'|'text'|'blob'|'response'} [options.as='json'] how to read a successful response
 * @returns {Promise<any>} parsed JSON (or text/blob/Response), null for 204
 */
export async function request(method, path, options = {}) {
  const {
    body,
    raw = false,
    headers = {},
    admin = false,
    auth = true,
    token: explicitToken,
    query,
    signal,
    timeout = DEFAULT_TIMEOUT_MS,
    as = 'json',
    probe = false,
  } = options;

  const url = buildUrl(path, query);
  const finalHeaders = { Accept: 'application/json', ...headers };
  const token = explicitToken ?? (auth ? tokens.get(admin) : null);
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  let payload;
  if (body !== undefined && body !== null) {
    if (raw || isRawBody(body)) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      finalHeaders['Content-Type'] = 'application/json';
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = timeout > 0 ? setTimeout(() => ((timedOut = true), controller.abort()), timeout) : null;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    if (signal?.aborted) throw new ApiError(0, 'ABORTED', 'Petición cancelada.');
    if (timedOut) throw new ApiError(0, 'TIMEOUT', 'El servidor tarda demasiado en responder. Inténtalo de nuevo.');
    if (!probe) setOnline(false);
    throw new ApiError(0, 'NETWORK', 'Sin conexión con el servidor. Comprueba la red e inténtalo de nuevo.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!probe) setOnline(true);

  if (!res.ok) {
    const error = await errorFromResponse(res);
    // A token that the server no longer accepts: forget it and let the app react.
    // PIN_* codes are wrong PINs (e.g. changing the admin PIN), not lost sessions.
    if (res.status === 401 && token && !explicitToken && !/^PIN_/.test(error.code)) {
      tokens.clear(admin);
      emit('unauthorized', { admin, error });
    }
    throw error;
  }

  if (as === 'response') return res;
  if (as === 'blob') return res.blob();
  if (as === 'text') return res.text();
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) return res.json();
  return res.text();
}

// ---------------------------------------------------------------------------
// Real-time channel (SSE)

const subscribers = new Set();
let source = null;
let sourceFailed = false;
let reconnectTimer = null;
let reconnectDelay = SSE_RETRY_MIN_MS;
let resyncTimer = null;
let hiddenSince = null;

function dispatch(event) {
  for (const fn of [...subscribers]) {
    try {
      fn(event);
    } catch (err) {
      console.error(err);
    }
  }
}

/** Coalesces "refresh everything" notifications (reconnect, back online, tab visible again). */
function scheduleResync() {
  if (!subscribers.size) return;
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => dispatch({ type: 'resync', toolIds: [] }), RESYNC_DEBOUNCE_MS);
}

function openStream() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const es = new EventSource('/api/events');
  source = es;

  es.addEventListener('open', () => {
    if (source !== es) return;
    reconnectDelay = SSE_RETRY_MIN_MS;
    setOnline(true);
    if (sourceFailed) {
      sourceFailed = false;
      scheduleResync();
    }
  });

  es.addEventListener('change', (message) => {
    if (source !== es) return;
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    dispatch({
      type: typeof data?.type === 'string' ? data.type : 'unknown',
      toolIds: Array.isArray(data?.toolIds) ? data.toolIds : [],
    });
  });

  es.addEventListener('error', () => {
    if (source !== es) return;
    sourceFailed = true;
    void checkConnection();
    if (es.readyState === EventSource.CLOSED) {
      // The browser gave up (e.g. HTTP error): retry ourselves with backoff.
      es.close();
      source = null;
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer || !subscribers.size) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (subscribers.size && !source) openStream();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, SSE_RETRY_MAX_MS);
}

function ensureStream() {
  if (!subscribers.size || typeof EventSource === 'undefined') return;
  if (source && source.readyState !== EventSource.CLOSED) return;
  if (source) source.close();
  source = null;
  sourceFailed = true; // whatever happened meanwhile was missed: resync on open
  openStream();
}

function closeStream() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (source) source.close();
  source = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenSince = Date.now();
    return;
  }
  const wasHiddenLong = hiddenSince !== null && Date.now() - hiddenSince > HIDDEN_RESYNC_MS;
  hiddenSince = null;
  ensureStream();
  if (wasHiddenLong) {
    void checkConnection();
    scheduleResync();
  }
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    ensureStream();
    scheduleResync();
  }
});

/**
 * Listens to server changes. `onChange` receives:
 *   { type: 'checkout'|'return'|'transfer'|'import'|'tools'|'operators'|'picklist', toolIds: number[] }
 *   ('picklist' does not say whose list changed: every client reads its own again)
 *   { type: 'resync', toolIds: [] } after a reconnection / coming back online / the page being
 *   hidden for a while: events may have been missed, so refresh everything that is visible.
 * One EventSource is shared by all subscribers. Returns an unsubscribe function.
 */
export function subscribe(onChange) {
  subscribers.add(onChange);
  if (subscribers.size === 1 && !source && typeof EventSource !== 'undefined') {
    sourceFailed = false;
    openStream();
  }
  return () => {
    subscribers.delete(onChange);
    if (!subscribers.size) closeStream();
  };
}

// ---------------------------------------------------------------------------
// Public client

const get = (path, options) => request('GET', path, options);
const post = (path, body, options = {}) => request('POST', path, { ...options, body: body ?? {} });
const patch = (path, body, options = {}) => request('PATCH', path, { ...options, body: body ?? {} });
const del = (path, options) => request('DELETE', path, options);

export const api = {
  request,
  get,
  post,
  patch,
  del,
  tokens,
  on,
  subscribe,
  isOnline,
  checkConnection,

  // Public ---------------------------------------------------------------
  /** GET /api/health -> { ok, version, tools } */
  health: (options) => get('/health', { auth: false, ...options }),
  /** GET /api/operators -> { operators: [{ id, name, hasPin }] } */
  operators: (options) => get('/operators', { auth: false, ...options }),
  /** POST /api/session -> { token, operator: { id, name } } (does not store the token) */
  login: (operatorId, pin) => post('/session', pin ? { operatorId, pin } : { operatorId }, { auth: false }),

  // Operator -------------------------------------------------------------
  /** DELETE /api/session (current token, or an explicit one) */
  logout: (token) => del('/session', token ? { token } : undefined),
  /** GET /api/me -> { operator: { id, name }, inUseCount, pickCount } */
  me: (options) => get('/me', options),
  /** GET /api/tools/search -> { query, total, tools } */
  search: (q, { limit = 30, signal } = {}) => get('/tools/search', { query: { q, limit }, signal }),
  /** GET /api/tools/:id -> { tool: Tool & { history } } */
  tool: (id, options) => get(`/tools/${encodeURIComponent(id)}`, options),
  /**
   * POST /api/tools/:id/checkout -> { tool } (409 HELD_BY_OTHER | TOOL_INACTIVE).
   * A transfer names the holder the operator confirmed (fromOperatorId): when someone else
   * holds it by now -> 409 HOLDER_CHANGED with data.holder.
   */
  checkout: (id, { transfer = false, fromOperatorId = null } = {}) =>
    post(
      `/tools/${encodeURIComponent(id)}/checkout`,
      transfer ? (fromOperatorId ? { transfer: true, fromOperatorId } : { transfer: true }) : {},
    ),
  /** POST /api/tools/:id/return -> { tool } */
  returnTool: (id) => post(`/tools/${encodeURIComponent(id)}/return`, {}),
  /** GET /api/me/tools -> { tools } in pick-up route order */
  myTools: (options) => get('/me/tools', options),
  /** POST /api/me/return -> { returned, skipped } (all mine when toolIds is omitted) */
  returnMine: (toolIds) => post('/me/return', Array.isArray(toolIds) ? { toolIds } : {}),
  /**
   * POST /api/me/checkout -> { taken, skipped: [{ toolId, code?, reason, holder? }] }: takes 1-200
   * tools at once, never transfers. reason: 'HELD_BY_OTHER' (with holder) | 'TOOL_INACTIVE' | 'NOT_FOUND'.
   */
  checkoutMany: (toolIds) => post('/me/checkout', { toolIds }),

  // Pick list: tools marked in the search to be taken later, zone by zone
  /** GET /api/me/picklist -> { tools: (Tool & { addedAt })[] } in pick-up route order */
  picklist: (options) => get('/me/picklist', options),
  /** POST /api/me/picklist -> { tools, skipped: [{ toolId, code?, reason: 'NOT_FOUND'|'ALREADY_MINE'|'TOOL_INACTIVE' }] } */
  addToPicklist: (toolIds) => post('/me/picklist', { toolIds }),
  /** DELETE /api/me/picklist/:id -> { tools } (idempotent) */
  removeFromPicklist: (id) => del(`/me/picklist/${encodeURIComponent(id)}`),
  /** DELETE /api/me/picklist -> { tools: [] } */
  clearPicklist: () => del('/me/picklist'),
};

export default api;
