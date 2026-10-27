// In-browser Nevko server for the demonstration: the REST API of docs/SPEC.md §4-§5
// (same routes, JSON shapes, status codes and Spanish error messages as server/routes/*.js,
// server/tools.js, server/picklist.js, server/operators.js, server/auth.js and
// server/importer/sync.js) over the state of store.js. The import uses the server's own pure
// modules (lib/importer/*).
//
//   const response = await handle({ method, path: '/tools/search', query, headers, body });
//   -> { status, body, headers? }   body: object (JSON) or undefined

import { ImportError } from '../lib/importer/columns.js';
import { parseCsv } from '../lib/importer/csv.js';
import { IMPORT_MODES, MAX_IMPORT_ROWS, computeDiff, matchRows, prepareRows, sameData } from '../lib/importer/rows.js';
import { FIELD_LIMITS, NAME_MAX_LENGTH } from '../lib/limits.js';
import {
  cleanText,
  codeKey,
  codeLoose,
  codeNorm,
  naturalCompare,
  resolveContainer,
  textNorm,
} from '../lib/normalize.js';
import { APP_VERSION } from './build-info.js';
import { PdfReaderUnavailable, parsePdfBytes } from './pdf.js';
import { beginChange, db, save, withSearchKeys } from './store.js';

const TOOL_STATUSES = ['all', 'active', 'in_use', 'available', 'inactive'];
const MAX_QUERY_WORDS = 8;
const MAX_RETURN_IDS = 1000;
const MAX_PICK_IDS = 200;
const OPERATOR_PIN_RE = /^\d{4,6}$/;
const ADMIN_PIN_RE = /^\d{4,8}$/;
const OPERATOR_SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;
const JSON_LIMIT = 64 * 1024;
const ROWS_JSON_LIMIT = 25 * 1024 * 1024;
const MB = 1024 * 1024;
const PDF_TYPES = ['application/pdf', 'application/x-pdf', 'application/octet-stream'];
const CSV_TYPES = ['application/csv', 'application/vnd.ms-excel'];
const IMPORT_ERROR_STATUS = { NO_TEXT: 422, EMPTY: 422, INVALID_PDF: 400, TOO_MANY_ROWS: 413, TOO_COMPLEX: 422 };

// ---------------------------------------------------------------------------
// Errors ({ error: { code, message, ...extra } })

export class DemoError extends Error {
  constructor(status, code, message, extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (code, message, extra) => new DemoError(400, code, message, extra);
const unauthorized = (code, message, extra) => new DemoError(401, code, message, extra);
const notFound = (code, message, extra) => new DemoError(404, code, message, extra);
const conflict = (code, message, extra) => new DemoError(409, code, message, extra);

export function errorResponse(err) {
  const headers = {};
  if (err.status === 429 && err.extra?.retryAfter) headers['Retry-After'] = String(err.extra.retryAfter);
  return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.extra ?? {}) } }, headers };
}

const toolNotFound = () => notFound('TOOL_NOT_FOUND', 'No existe ese útil.');
const operatorNotFound = () => notFound('OPERATOR_NOT_FOUND', 'No existe ese operario.');
const demoUnavailable = () => conflict('DEMO_UNAVAILABLE', 'No disponible en la demostración.');

// ---------------------------------------------------------------------------
// Small helpers (server/errors.js)

function parseId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
}

function parseIntParam(value, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const bodyOf = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
const pinInput = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
const nowIso = () => new Date().toISOString();
const queryText = (query, key) => (query.has(key) ? query.get(key).slice(0, 200) : '');

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Events (the mock EventSource and other tabs listen to them)

const eventListeners = new Set();

/** Subscribes to changes: fn({ type, toolIds }). */
export function onChange(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

function broadcast(type, toolIds = []) {
  const event = { type, toolIds: [...new Set(toolIds)] };
  for (const fn of [...eventListeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error(err);
    }
  }
}

// ---------------------------------------------------------------------------
// PIN attempts (server/auth.js RateLimiter: 5 failures -> 30 s, doubling up to 15 min)

const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
const QUIET_MS = 60 * 60_000;
const attempts = new Map(); // target -> { failures, locks, lockedUntil, lastAttempt }

function attemptEntry(target, create = false) {
  const now = Date.now();
  let entry = attempts.get(target);
  if (entry && !(entry.lockedUntil > now) && now - entry.lastAttempt > QUIET_MS) {
    attempts.delete(target);
    entry = undefined;
  }
  if (!entry && create) {
    entry = { failures: 0, locks: 0, lockedUntil: 0, lastAttempt: now };
    attempts.set(target, entry);
  }
  return entry;
}

const retryAfterOf = (entry) => Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 1000));

function tooManyAttempts(retryAfter) {
  return new DemoError(
    429,
    'TOO_MANY_ATTEMPTS',
    `Demasiados intentos fallidos. Espera ${retryAfter} s antes de volver a intentarlo.`,
    { retryAfter },
  );
}

/** Verifies a PIN under the attempt limits; throws 429 or `invalidError(attemptsLeft)`. */
function verifyPin(target, pin, stored, invalidError) {
  const current = attemptEntry(target);
  if (current && current.lockedUntil > Date.now()) {
    current.lastAttempt = Date.now();
    throw tooManyAttempts(retryAfterOf(current));
  }
  const entry = attemptEntry(target, true);
  entry.failures += 1;
  entry.lastAttempt = Date.now();
  if (entry.failures >= MAX_FAILURES) {
    const duration = Math.min(LOCKOUT_MS * 2 ** entry.locks, MAX_LOCKOUT_MS);
    entry.locks += 1;
    entry.failures = 0;
    entry.lockedUntil = Date.now() + duration;
  }
  if (typeof stored === 'string' && pin === stored) {
    attempts.delete(target);
    return;
  }
  if (entry.lockedUntil > Date.now()) throw tooManyAttempts(retryAfterOf(entry));
  throw invalidError(Math.max(0, MAX_FAILURES - entry.failures));
}

// ---------------------------------------------------------------------------
// Sessions

const SESSION_MESSAGES = {
  operator: {
    missing: 'Identifícate para continuar.',
    invalid: 'Tu sesión ha caducado o no es válida. Vuelve a identificarte.',
  },
  admin: {
    missing: 'Introduce el PIN de administración para continuar.',
    invalid: 'La sesión de administración ha caducado o no es válida. Vuelve a introducir el PIN.',
  },
};

function createSession(kind, operatorId = null) {
  const token = randomToken();
  const now = nowIso();
  db().sessions.push({ token, kind, operatorId, createdAt: now, lastSeenAt: now });
  return token;
}

function resolveSession(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const state = db();
  const session = state.sessions.find((s) => s.token === token);
  if (!session) return null;
  const ttl = session.kind === 'admin' ? ADMIN_SESSION_TTL_MS : OPERATOR_SESSION_TTL_MS;
  const idle = Date.now() - Date.parse(session.lastSeenAt);
  const operator = session.operatorId ? state.operators.find((op) => op.id === session.operatorId) : null;
  if (!(idle < ttl) || (session.kind === 'operator' && operator?.active !== 1)) {
    state.sessions = state.sessions.filter((s) => s !== session);
    save();
    return null;
  }
  if (idle > TOUCH_INTERVAL_MS) {
    session.lastSeenAt = nowIso();
    save();
  }
  return { kind: session.kind, operatorId: session.operatorId, operatorName: operator?.name ?? null, token };
}

function requireSession(headers, kind) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.get('authorization') ?? '');
  if (!match) throw unauthorized('AUTH_REQUIRED', SESSION_MESSAGES[kind].missing);
  const session = resolveSession(match[1]);
  if (!session || session.kind !== kind) throw unauthorized('SESSION_INVALID', SESSION_MESSAGES[kind].invalid);
  return session;
}

function destroySession(token) {
  const state = db();
  state.sessions = state.sessions.filter((s) => s.token !== token);
}

// ---------------------------------------------------------------------------
// Tools (server/tools.js)

function openCheckouts() {
  const byTool = new Map();
  for (const c of db().checkouts) if (c.returnedAt === null) byTool.set(c.toolId, c);
  return byTool;
}

const operatorById = (id) => db().operators.find((op) => op.id === id) ?? null;
const toolById = (id) => db().tools.find((tool) => tool.id === id) ?? null;

function toHolder(open, viewerId = null) {
  if (!open) return null;
  return {
    operatorId: open.operatorId,
    name: operatorById(open.operatorId)?.name ?? '',
    since: open.takenAt,
    isMe: viewerId !== null && viewerId !== undefined && open.operatorId === viewerId,
  };
}

/**
 * Active units of every code, by id (server/tools.js unitNumbers and KitFinder):
 * { byKey: Map<codeKey, tool[]>, byNorm: Map<codeNorm, tool[]>, find(text) } where find()
 * returns the units of the code written as `text` (by code key, else by code_norm) for
 * resolveContainer().
 */
function activeUnits() {
  const byKey = new Map();
  const byNorm = new Map();
  for (const tool of [...db().tools].sort((a, b) => a.id - b.id)) {
    if (tool.active !== 1) continue;
    if (!byKey.has(tool.codeKey)) byKey.set(tool.codeKey, []);
    byKey.get(tool.codeKey).push(tool);
    if (!byNorm.has(tool.codeNorm)) byNorm.set(tool.codeNorm, []);
    byNorm.get(tool.codeNorm).push(tool);
  }
  const find = (text) => {
    const key = codeKey(text);
    if (!key) return null;
    let units = byKey.get(key) ?? [];
    let found = key;
    if (!units.length) {
      const similar = byNorm.get(codeNorm(text)) ?? [];
      if (!similar.length) return null;
      found = similar[0].codeKey;
      units = similar.filter((unit) => unit.codeKey === found);
    }
    return { code: units[0].code, key: found, units };
  };
  return { byKey, byNorm, find };
}

/** unitIndex (1-based among the active units of its code, by id; null if retired) and unitCount. */
function unitOf(tool, units) {
  const list = units.byKey.get(tool.codeKey) ?? [];
  const index = tool.active === 1 ? list.findIndex((unit) => unit.id === tool.id) + 1 : 0;
  return { unitIndex: index || null, unitCount: list.length };
}

function toTool(tool, open, viewerId = null, units = activeUnits()) {
  return {
    id: tool.id,
    code: tool.code,
    location: tool.location,
    description: tool.description,
    active: tool.active === 1,
    holder: toHolder(open, viewerId),
    ...unitOf(tool, units),
    container: resolveContainer(tool.location, tool.codeKey, units.find),
  };
}

/** Tool JSON of state tools (server/tools.js toTools): holder, unit numbers and kit. */
function toTools(tools, viewerId = null) {
  if (!tools.length) return [];
  const open = openCheckouts();
  const units = activeUnits();
  return tools.map((tool) => toTool(tool, open.get(tool.id) ?? null, viewerId, units));
}

function requireTool(id, viewerId = null) {
  const tool = toolById(id);
  if (!tool) throw toolNotFound();
  return toTools([tool], viewerId)[0];
}

function getMany(ids, viewerId = null) {
  const byId = new Map(db().tools.map((tool) => [tool.id, tool]));
  return toTools(ids.map((id) => byId.get(id)).filter(Boolean), viewerId);
}

/** Sort by location (natural order, empty locations last) and then by code. */
function compareByLocation(a, b) {
  if (!a.location !== !b.location) return a.location ? -1 : 1;
  return naturalCompare(a.location, b.location) || naturalCompare(a.code, b.code) || a.id - b.id;
}

/**
 * Orders rows ({ tool, tier?, noLocation? }) keeping the units of a code together, by id
 * (server/tools.js sortUnits): tier, a code with a located unit first, natural order of the
 * code as written in its first unit, code key. Sorts in place.
 */
function sortUnits(rows) {
  const groups = new Map();
  const groupOf = (row) => `${row.tier ?? 0} ${row.tool.codeKey}`;
  for (const row of rows) {
    const id = groupOf(row);
    const group = groups.get(id);
    if (!group) {
      groups.set(id, { id: row.tool.id, code: row.tool.code, noLocation: row.noLocation ?? 0 });
      continue;
    }
    group.noLocation = Math.min(group.noLocation, row.noLocation ?? 0);
    if (row.tool.id < group.id) Object.assign(group, { id: row.tool.id, code: row.tool.code });
  }
  return rows.sort((a, b) => {
    const tier = (a.tier ?? 0) - (b.tier ?? 0);
    if (tier) return tier;
    const ga = groups.get(groupOf(a));
    const gb = groups.get(groupOf(b));
    if (ga !== gb) {
      const ka = a.tool.codeKey;
      const kb = b.tool.codeKey;
      return ga.noLocation - gb.noLocation || naturalCompare(ga.code, gb.code) || (ka < kb ? -1 : ka > kb ? 1 : 0);
    }
    return a.tool.id - b.tool.id;
  });
}

const withoutZeroPadding = (value, norm) => codeLoose(value) === norm;

/** Ranking tiers of SPEC §4 for a query; returns tool -> tier | null, or null for an empty query. */
function rankingFor(q) {
  const qNorm = codeNorm(q);
  const words = [...new Set(textNorm(q).split(' ').filter(Boolean))].slice(0, MAX_QUERY_WORDS);
  if (!qNorm && words.length === 0) return null;
  const loose = Boolean(qNorm) && withoutZeroPadding(q, qNorm);
  const wordTests = words.map((word) => {
    const norm = codeNorm(word);
    return { word, norm, loose: Boolean(norm) && withoutZeroPadding(word, norm) };
  });
  return (tool) => {
    if (qNorm) {
      if (tool.codeNorm === qNorm) return 0;
      if (loose && tool.codeLoose === qNorm) return 1;
      if (tool.codeNorm.startsWith(qNorm)) return 2;
      if (loose && tool.codeLoose.startsWith(qNorm)) return 3;
      if (tool.codeNorm.includes(qNorm)) return 4;
      if (loose && tool.codeLoose.includes(qNorm)) return 5;
    }
    if (
      words.length &&
      wordTests.every(
        (w) =>
          tool.descriptionNorm.includes(w.word) ||
          tool.locationNorm.includes(w.word) ||
          (w.norm && (tool.codeNorm.includes(w.norm) || (w.loose && tool.codeLoose.includes(w.norm)))),
      )
    ) {
      return 6;
    }
    return null;
  };
}

function ranked(q, candidates) {
  const tierOf = rankingFor(q);
  if (!tierOf) return [];
  const rows = [];
  for (const tool of candidates) {
    const tier = tierOf(tool);
    if (tier !== null) rows.push({ tool, tier, noLocation: tool.location === '' ? 1 : 0 });
  }
  return sortUnits(rows).map((row) => row.tool);
}

function searchTools(q, { limit, viewerId }) {
  const query = cleanText(q);
  if (!query) return { query, total: 0, tools: [] };
  const matches = ranked(query, db().tools.filter((tool) => tool.active === 1));
  return { query, total: matches.length, tools: getMany(matches.slice(0, limit).map((t) => t.id), viewerId) };
}

function listTools({ q, status, offset, limit }) {
  const open = openCheckouts();
  const filters = {
    all: () => true,
    active: (t) => t.active === 1,
    in_use: (t) => open.has(t.id),
    available: (t) => t.active === 1 && !open.has(t.id),
    inactive: (t) => t.active === 0,
  };
  const candidates = db().tools.filter(filters[status] ?? filters.active);
  const query = cleanText(q);
  const ordered = query ? ranked(query, candidates) : sortUnits(candidates.map((tool) => ({ tool }))).map((row) => row.tool);
  return { total: ordered.length, tools: getMany(ordered.slice(offset, offset + limit).map((t) => t.id)) };
}

function heldBy(operatorId) {
  const tools = [];
  for (const c of db().checkouts) {
    if (c.returnedAt !== null || c.operatorId !== operatorId) continue;
    const tool = toolById(c.toolId);
    if (tool) tools.push(tool);
  }
  return toTools(tools, operatorId).sort(compareByLocation);
}

const countHeldBy = (operatorId) => db().checkouts.filter((c) => c.returnedAt === null && c.operatorId === operatorId).length;

function shortHistory(toolId, limit = 5) {
  return db()
    .checkouts.filter((c) => c.toolId === toolId)
    .sort((a, b) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : b.id - a.id))
    .slice(0, limit)
    .map((c) => ({
      operatorName: operatorById(c.operatorId)?.name ?? '',
      takenAt: c.takenAt,
      returnedAt: c.returnedAt,
      returnType: c.returnType,
    }));
}

function closeCheckout(checkout, returnType, closedBy) {
  checkout.returnedAt = nowIso();
  checkout.returnType = returnType;
  checkout.closedBy = closedBy;
}

function insertCheckout(toolId, operatorId, takenAt) {
  const state = db();
  state.seq.checkout += 1;
  state.checkouts.push({ id: state.seq.checkout, toolId, operatorId, takenAt, returnedAt: null, returnType: null, closedBy: null });
}

const heldByOther = (open) => {
  const holder = toHolder(open, null);
  return conflict('HELD_BY_OTHER', `Este útil lo tiene ${holder.name}.`, { holder });
};

/**
 * Checkout steps shared by checkout() and checkoutMany() (server/tools.js #assign): returns
 * 'checkout' | 'transfer' | null (already mine) or throws. A tool the operator ends up
 * holding leaves their pick list.
 */
function assign(toolId, operatorId, { transfer = false, fromOperatorId = null } = {}) {
  const tool = toolById(toolId);
  if (!tool) throw toolNotFound();
  const open = openCheckouts().get(toolId) ?? null;
  if (open && open.operatorId === operatorId) {
    unpick(operatorId, toolId);
    return null;
  }
  if (tool.active !== 1) throw conflict('TOOL_INACTIVE', 'Este útil está dado de baja y no se puede usar.');
  const now = nowIso();
  if (open) {
    if (!transfer) throw heldByOther(open);
    if (fromOperatorId !== null && open.operatorId !== fromOperatorId) {
      const holder = toHolder(open, operatorId);
      throw conflict('HOLDER_CHANGED', `Este útil ha cambiado de manos: ahora lo tiene ${holder.name}.`, { holder });
    }
    open.returnedAt = now;
    open.returnType = 'transferred';
    open.closedBy = operatorId;
  }
  insertCheckout(toolId, operatorId, now);
  unpick(operatorId, toolId);
  return open ? 'transfer' : 'checkout';
}

function checkout(toolId, operatorId, options) {
  const event = assign(toolId, operatorId, options);
  return { tool: requireTool(toolId, operatorId), event };
}

/** Batch take without transfers (server/tools.js checkoutMany). */
function checkoutMany(operatorId, toolIds) {
  const takenIds = [];
  const checkedOut = [];
  const skipped = [];
  for (const toolId of new Set(toolIds)) {
    try {
      if (assign(toolId, operatorId)) checkedOut.push(toolId);
      takenIds.push(toolId);
    } catch (err) {
      if (!(err instanceof DemoError)) throw err;
      if (err.code === 'TOOL_NOT_FOUND') {
        skipped.push({ toolId, reason: 'NOT_FOUND' });
        continue;
      }
      if (err.code !== 'TOOL_INACTIVE' && err.code !== 'HELD_BY_OTHER') throw err;
      const skip = { toolId, code: toolById(toolId)?.code ?? '', reason: err.code };
      if (err.extra?.holder) skip.holder = err.extra.holder;
      skipped.push(skip);
    }
  }
  return { taken: getMany(takenIds, operatorId).sort(compareByLocation), skipped, checkedOut };
}

// ---------------------------------------------------------------------------
// Pick lists (server/picklist.js)

function unpick(operatorId, toolId) {
  const state = db();
  state.picklist = state.picklist.filter((p) => !(p.operatorId === operatorId && p.toolId === toolId));
}

const countPicks = (operatorId) => db().picklist.filter((p) => p.operatorId === operatorId).length;

function listPicks(operatorId) {
  const picks = [];
  for (const pick of db().picklist) {
    if (pick.operatorId !== operatorId) continue;
    const tool = toolById(pick.toolId);
    if (tool) picks.push({ tool, addedAt: pick.addedAt });
  }
  return toTools(picks.map((pick) => pick.tool), operatorId)
    .map((tool, i) => ({ ...tool, addedAt: picks[i].addedAt }))
    .sort(compareByLocation);
}

function addPicks(operatorId, toolIds) {
  const state = db();
  const open = openCheckouts();
  const added = [];
  const skipped = [];
  const now = nowIso();
  for (const toolId of new Set(toolIds)) {
    const tool = toolById(toolId);
    if (!tool) skipped.push({ toolId, reason: 'NOT_FOUND' });
    else if (open.get(toolId)?.operatorId === operatorId) skipped.push({ toolId, code: tool.code, reason: 'ALREADY_MINE' });
    else if (tool.active !== 1) skipped.push({ toolId, code: tool.code, reason: 'TOOL_INACTIVE' });
    else if (!state.picklist.some((p) => p.operatorId === operatorId && p.toolId === toolId)) {
      state.picklist.push({ operatorId, toolId, addedAt: now });
      added.push(toolId);
    }
  }
  return { added, skipped };
}

function removePick(operatorId, toolId) {
  const before = countPicks(operatorId);
  unpick(operatorId, toolId);
  return countPicks(operatorId) < before;
}

function clearPicks(operatorId) {
  const state = db();
  const ids = state.picklist.filter((p) => p.operatorId === operatorId).map((p) => p.toolId);
  state.picklist = state.picklist.filter((p) => p.operatorId !== operatorId);
  return ids;
}

/** `toolIds` of the pick list and batch checkout bodies (server/routes/operator.js pickIds). */
function pickIds(value) {
  const invalid = () => badRequest('VALIDATION', 'La lista de útiles no es válida.');
  if (!Array.isArray(value) || value.length === 0) throw invalid();
  if (value.length > MAX_PICK_IDS) {
    throw badRequest('VALIDATION', `Se pueden indicar como máximo ${MAX_PICK_IDS} útiles a la vez.`);
  }
  const ids = value.map((item) => parseId(item));
  if (ids.some((id) => id === null)) throw invalid();
  return ids;
}

function giveBack(toolId, operatorId) {
  if (!toolById(toolId)) throw toolNotFound();
  const open = openCheckouts().get(toolId) ?? null;
  if (!open) return { tool: requireTool(toolId, operatorId), event: null };
  if (open.operatorId !== operatorId) throw heldByOther(open);
  closeCheckout(open, 'returned', operatorId);
  return { tool: requireTool(toolId, operatorId), event: 'return' };
}

function giveBackMany(operatorId, toolIds) {
  const open = openCheckouts();
  const mine = new Map([...open].filter(([, c]) => c.operatorId === operatorId));
  const targets = [];
  const skipped = [];
  if (toolIds === null) {
    targets.push(...mine.keys());
  } else {
    for (const toolId of new Set(toolIds)) {
      if (mine.has(toolId)) targets.push(toolId);
      else if (!toolById(toolId)) skipped.push({ toolId, reason: 'NOT_FOUND' });
      else skipped.push({ toolId, reason: open.has(toolId) ? 'HELD_BY_OTHER' : 'NOT_IN_USE' });
    }
  }
  for (const toolId of targets) closeCheckout(mine.get(toolId), 'returned', operatorId);
  return { returned: getMany(targets, operatorId).sort(compareByLocation), skipped };
}

function forceReturn(toolId) {
  if (!toolById(toolId)) throw toolNotFound();
  const open = openCheckouts().get(toolId) ?? null;
  if (!open) return { tool: requireTool(toolId), event: null };
  closeCheckout(open, 'forced', null);
  return { tool: requireTool(toolId), event: 'return' };
}

function forceReturnAllOf(operatorId) {
  const open = db().checkouts.filter((c) => c.returnedAt === null && c.operatorId === operatorId);
  for (const c of open) closeCheckout(c, 'forced', null);
  return open.map((c) => c.toolId);
}

/** Validates and cleans tool fields. `partial` allows missing fields (PATCH). */
function cleanToolFields(input, { partial = false } = {}) {
  const out = {};
  for (const field of ['code', 'location', 'description']) {
    const value = input[field];
    if (value === undefined) {
      if (!partial && field === 'code') throw badRequest('CODE_REQUIRED', 'Indica el código del útil.');
      if (!partial) out[field] = '';
      continue;
    }
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
      throw badRequest('VALIDATION', `El campo «${field}» no es válido.`);
    }
    const text = cleanText(value);
    if (text.length > FIELD_LIMITS[field]) {
      throw badRequest('VALIDATION', `El campo «${field}» supera los ${FIELD_LIMITS[field]} caracteres.`);
    }
    out[field] = text;
  }
  if (out.code !== undefined) {
    if (!out.code) throw badRequest('CODE_REQUIRED', 'Indica el código del útil.');
    if (!codeNorm(out.code)) throw badRequest('CODE_INVALID', 'El código debe contener al menos una letra o un número.');
  }
  return out;
}

/** `allowDuplicate` of a create/edit body: absent or boolean, otherwise 400 VALIDATION. */
function allowDuplicateOf(input) {
  const value = input.allowDuplicate;
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw badRequest('VALIDATION', 'El campo «allowDuplicate» debe ser verdadero o falso.');
  return value;
}

/** 409 CODE_EXISTS when the code key already has units (other than `exceptId`), else null. */
function codeExists(key, exceptId = null) {
  const units = db()
    .tools.filter((t) => t.codeKey === key && t.id !== exceptId)
    .sort((a, b) => b.active - a.active || a.id - b.id);
  if (!units.length) return null;
  const active = units.filter((unit) => unit.active === 1);
  const first = units[0];
  const locations = [...new Set(active.map((unit) => unit.location).filter(Boolean))];
  let message;
  if (!active.length) message = `Ya existe ${first.code}, dado de baja. Reactívalo o añade otra unidad.`;
  else if (active.length > 1) message = `Ya hay ${active.length} unidades de ${first.code}.`;
  else if (first.location) message = `Ya existe ${first.code} en ${first.location}.`;
  else message = `Ya existe ${first.code} (sin ubicación).`;
  return conflict('CODE_EXISTS', message, {
    toolId: first.id,
    active: first.active === 1,
    toolCode: first.code,
    location: first.location,
    locations,
    unitCount: active.length,
    canAddUnit: true,
  });
}

/** 409 when another ACTIVE tool has the same code written differently (not a unit of the same key). */
function sameCodeNorm(norm, key, exceptId = null) {
  const existing = db()
    .tools.filter((t) => t.codeNorm === norm && t.codeKey !== key && t.active === 1 && t.id !== exceptId)
    .sort((a, b) => a.id - b.id)[0];
  if (!existing) return null;
  return conflict('CODE_EXISTS', `Ya existe el útil ${existing.code}, que es el mismo código escrito de otra forma.`, {
    toolId: existing.id,
    active: true,
    toolCode: existing.code,
    similar: true,
  });
}

function createTool(input) {
  const fields = cleanToolFields(input);
  const allowDuplicate = allowDuplicateOf(input);
  const key = codeKey(fields.code);
  if (!allowDuplicate) {
    const existing = codeExists(key);
    if (existing) throw existing;
  }
  const similar = sameCodeNorm(codeNorm(fields.code), key);
  if (similar) throw similar;
  const state = db();
  const now = nowIso();
  state.seq.tool += 1;
  const tool = withSearchKeys({ id: state.seq.tool, ...fields, active: 1, createdAt: now, updatedAt: now });
  state.tools.push(tool);
  return requireTool(tool.id);
}

function updateTool(id, input) {
  const fields = cleanToolFields(input, { partial: true });
  if (input.active !== undefined && typeof input.active !== 'boolean') {
    throw badRequest('VALIDATION', 'El campo «active» debe ser verdadero o falso.');
  }
  const allowDuplicate = allowDuplicateOf(input);
  const current = toolById(id);
  if (!current) throw toolNotFound();
  const next = {
    code: fields.code ?? current.code,
    location: fields.location ?? current.location,
    description: fields.description ?? current.description,
    active: input.active === undefined ? current.active : input.active ? 1 : 0,
  };
  const codeChanged = next.code !== current.code;
  const key = codeChanged ? codeKey(next.code) : current.codeKey;
  if (key !== current.codeKey && !allowDuplicate) {
    const existing = codeExists(key, id);
    if (existing) throw existing;
  }
  const reactivated = current.active !== 1 && next.active === 1;
  if (next.active === 1 && (codeChanged || reactivated)) {
    const similar = sameCodeNorm(codeNorm(next.code), key, id);
    if (similar) throw similar;
  }
  Object.assign(current, next, { updatedAt: nowIso() });
  withSearchKeys(current);
  return requireTool(id);
}

function summary() {
  const state = db();
  const open = openCheckouts();
  const counts = {
    tools: state.tools.length,
    active: state.tools.filter((t) => t.active === 1).length,
    inUse: open.size,
    available: state.tools.filter((t) => t.active === 1 && !open.has(t.id)).length,
    operators: state.operators.filter((op) => op.active === 1).length,
  };
  const loans = [...open.values()].sort((a, b) => (a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : a.id - b.id));
  const inUse = toTools(loans.map((c) => toolById(c.toolId))).map((tool) => ({ tool, holder: tool.holder }));
  const last = [...state.imports].sort((a, b) => b.id - a.id)[0] ?? null;
  const lastImport = last
    ? {
        id: last.id,
        filename: last.filename,
        mode: last.mode,
        createdAt: last.createdAt,
        inserted: last.inserted,
        updated: last.updated,
        unchanged: last.unchanged,
        deactivated: last.deactivated,
        reactivated: last.reactivated,
      }
    : null;
  return { counts, inUse, lastImport };
}

function history({ q, operatorId, offset, limit }) {
  const state = db();
  let rows = state.checkouts;
  if (operatorId !== null) rows = rows.filter((c) => c.operatorId === operatorId);
  const query = cleanText(q);
  if (query) {
    const qt = textNorm(query);
    const operatorIds = new Set(state.operators.filter((op) => textNorm(op.name).includes(qt)).map((op) => op.id));
    const qNorm = codeNorm(query);
    const loose = Boolean(qNorm) && withoutZeroPadding(query, qNorm);
    const toolIds = new Set(
      state.tools
        .filter(
          (t) => t.locationNorm.includes(qt) || (qNorm && (t.codeNorm.includes(qNorm) || (loose && t.codeLoose.includes(qNorm)))),
        )
        .map((t) => t.id),
    );
    rows = rows.filter((c) => operatorIds.has(c.operatorId) || toolIds.has(c.toolId));
  }
  const sorted = [...rows].sort((a, b) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : b.id - a.id));
  const units = activeUnits();
  const items = sorted.slice(offset, offset + limit).map((c) => {
    const tool = toolById(c.toolId);
    const unit = tool ? unitOf(tool, units) : { unitIndex: null, unitCount: 0 };
    return {
      id: c.id,
      tool: { id: c.toolId, code: tool?.code ?? '', location: tool?.location ?? '', ...unit },
      operator: { id: c.operatorId, name: operatorById(c.operatorId)?.name ?? '' },
      takenAt: c.takenAt,
      returnedAt: c.returnedAt,
      returnType: c.returnType,
      closedByName: c.closedBy ? operatorById(c.closedBy)?.name ?? null : null,
    };
  });
  return { total: sorted.length, items };
}

// ---------------------------------------------------------------------------
// Operators (server/operators.js)

const nameExists = () => conflict('NAME_EXISTS', 'Ya hay un operario activo con ese nombre.');

function cleanName(value) {
  if (typeof value !== 'string') throw badRequest('NAME_REQUIRED', 'Indica el nombre del operario.');
  const name = cleanText(value);
  if (!name) throw badRequest('NAME_REQUIRED', 'Indica el nombre del operario.');
  if (name.length > NAME_MAX_LENGTH) {
    throw badRequest('VALIDATION', `El nombre no puede superar los ${NAME_MAX_LENGTH} caracteres.`);
  }
  return name;
}

function validPin(value) {
  if (typeof value !== 'string' || !OPERATOR_PIN_RE.test(value)) {
    throw badRequest('PIN_FORMAT', 'El PIN del operario debe tener entre 4 y 6 dígitos.');
  }
  return value;
}

function nameTaken(name, exceptId = null) {
  const wanted = textNorm(name);
  return db().operators.some((op) => op.active === 1 && op.id !== exceptId && textNorm(op.name) === wanted);
}

function listActiveOperators() {
  return db()
    .operators.filter((op) => op.active === 1)
    .map((op) => ({ id: op.id, name: op.name, hasPin: op.pin !== null }))
    .sort((a, b) => naturalCompare(a.name, b.name) || a.id - b.id);
}

function adminOperator(op) {
  return { id: op.id, name: op.name, hasPin: op.pin !== null, active: op.active === 1, inUseCount: countHeldBy(op.id) };
}

function listAllOperators() {
  return db()
    .operators.map(adminOperator)
    .sort((a, b) => Number(b.active) - Number(a.active) || naturalCompare(a.name, b.name) || a.id - b.id);
}

function getAdminOperator(id) {
  const op = operatorById(id);
  if (!op) throw operatorNotFound();
  return adminOperator(op);
}

function createOperator(input) {
  const name = cleanName(input.name);
  const pin = input.pin === undefined || input.pin === null || input.pin === '' ? null : validPin(input.pin);
  if (nameTaken(name)) throw nameExists();
  const state = db();
  state.seq.operator += 1;
  state.operators.push({ id: state.seq.operator, name, pin, active: 1, createdAt: nowIso() });
  return getAdminOperator(state.seq.operator);
}

function updateOperator(id, input) {
  const changes = {};
  if (input.name !== undefined) changes.name = cleanName(input.name);
  if (input.pin !== undefined) changes.pin = input.pin === null ? null : validPin(input.pin);
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw badRequest('VALIDATION', 'El campo «active» debe ser verdadero o falso.');
    changes.active = input.active ? 1 : 0;
  }
  const current = operatorById(id);
  if (!current) throw operatorNotFound();
  const next = {
    name: changes.name ?? current.name,
    pin: 'pin' in changes ? changes.pin : current.pin,
    active: changes.active ?? current.active,
  };
  if (next.active === 1 && nameTaken(next.name, id)) throw nameExists();
  const deactivated = current.active === 1 && next.active === 0;
  Object.assign(current, next);
  // A deactivated operator's pick list is dropped (their loans stay open).
  if (deactivated) clearPicks(id);
  return { operator: getAdminOperator(id), deactivated, pinChanged: 'pin' in changes };
}

// ---------------------------------------------------------------------------
// Import (server/routes/import.js + server/importer/sync.js)

function decodeFilename(headers) {
  const raw = headers.get('x-filename');
  if (!raw) return null;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // Keep the raw header value.
  }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 255);
  return name || null;
}

function hasPdfSignature(bytes) {
  const head = bytes.subarray(0, 1024);
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  return text.includes('%PDF-');
}

const unsupportedType = () => new DemoError(415, 'UNSUPPORTED_TYPE', 'Formato no admitido. Sube un archivo PDF o CSV.');
const tooLarge = () => new DemoError(413, 'PAYLOAD_TOO_LARGE', 'El archivo o la petición es demasiado grande.');

async function parseImport(headers, bytes) {
  const type = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const filename = decodeFilename(headers);
  const pdfType = PDF_TYPES.includes(type);
  const csvType = type.startsWith('text/') || CSV_TYPES.includes(type);
  if (!pdfType && !csvType) {
    if (!type && !bytes?.length) throw new DemoError(422, 'EMPTY', 'No se ha recibido ningún archivo.');
    throw unsupportedType();
  }
  const body = bytes ?? new Uint8Array(0);
  if (body.length > (pdfType ? 30 : 10) * MB) throw tooLarge();
  if (body.length === 0) throw new DemoError(422, 'EMPTY', 'El archivo está vacío.');

  const isPdf = hasPdfSignature(body);
  const looksCsv = /\.(csv|txt|tsv)$/i.test(filename ?? '');
  let kind;
  if (isPdf) kind = 'pdf';
  else if (type === 'application/pdf' || type === 'application/x-pdf') kind = 'pdf';
  else if (type === 'application/octet-stream') kind = looksCsv ? 'csv' : /\.pdf$/i.test(filename ?? '') ? 'pdf' : null;
  else kind = 'csv';
  if (!kind) throw unsupportedType();

  try {
    const result = kind === 'pdf' ? await parsePdfBytes(body, { maxRows: MAX_IMPORT_ROWS }) : parseCsv(body, { maxRows: MAX_IMPORT_ROWS });
    return { ...result, filename };
  } catch (err) {
    if (err instanceof PdfReaderUnavailable) {
      throw new DemoError(
        503,
        'PDF_READER_UNAVAILABLE',
        'En la demostración, los PDF se leen con un componente que se descarga de internet y no se ha podido cargar. ' +
          'Comprueba la conexión y vuelve a intentarlo, o importa el listado como CSV.',
      );
    }
    if (err instanceof ImportError) throw new DemoError(IMPORT_ERROR_STATUS[err.code] ?? 422, err.code, err.message);
    throw err;
  }
}

function assertRows(rows) {
  if (!Array.isArray(rows)) throw badRequest('VALIDATION', 'Falta la lista de filas a importar.');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new DemoError(413, 'TOO_MANY_ROWS', `El archivo tiene demasiadas filas (máximo ${MAX_IMPORT_ROWS}).`);
  }
}

/** Existing tools in the shape of rows.js matchRows(). */
function existingTools() {
  const open = openCheckouts();
  return db().tools.map((t) => ({
    id: t.id,
    code: t.code,
    codeKey: t.codeKey,
    codeNorm: t.codeNorm,
    location: t.location,
    description: t.description,
    active: t.active,
    inUse: open.has(t.id) ? 1 : 0,
  }));
}

/** Import commit (server/importer/sync.js): every row is one unit, paired by matchRows(). */
function commitImport(rows, { mode, filename }) {
  const { groups } = prepareRows(rows);
  if (groups.size === 0) throw new DemoError(422, 'EMPTY', 'No hay ninguna fila válida para importar.');
  const state = db();
  const now = nowIso();
  const existing = existingTools();
  const byId = new Map(state.tools.map((tool) => [tool.id, tool]));
  const result = { inserted: 0, updated: 0, unchanged: 0, deactivated: 0, reactivated: 0, renamed: 0 };
  const matched = new Set();
  for (const { row, tool, renamed } of matchRows(existing, groups)) {
    if (!tool) {
      state.seq.tool += 1;
      const { code, location, description } = row;
      state.tools.push(withSearchKeys({ id: state.seq.tool, code, location, description, active: 1, createdAt: now, updatedAt: now }));
      result.inserted++;
      continue;
    }
    matched.add(tool.id);
    if (tool.active === 1 && sameData(tool, row)) {
      result.unchanged++;
      continue;
    }
    withSearchKeys(Object.assign(byId.get(tool.id), { code: row.code, location: row.location, description: row.description, active: 1, updatedAt: now }));
    if (tool.active === 1) result.updated++;
    else result.reactivated++;
    if (renamed) result.renamed++;
  }
  if (mode === 'replace') {
    for (const tool of existing) {
      if (tool.active === 1 && !matched.has(tool.id)) {
        Object.assign(byId.get(tool.id), { active: 0, updatedAt: now });
        result.deactivated++;
      }
    }
  }
  const cleanName = filename ? cleanText(filename).slice(0, 255) || null : null;
  state.seq.import += 1;
  const { inserted, updated, unchanged, deactivated, reactivated } = result;
  state.imports.push({ id: state.seq.import, filename: cleanName, mode, createdAt: now, inserted, updated, unchanged, deactivated, reactivated });
  return { importId: state.seq.import, ...result };
}

// ---------------------------------------------------------------------------
// Routes (same order as server/app.js: import, public, admin, operator)

const routes = [];
const route = (method, pattern, auth, handler, options = {}) => routes.push({ method, pattern, auth, handler, ...options });
/** Handler result; `event` is broadcast once the change is saved (like the server's events.broadcast). */
const ok = (body, status = 200, event = null) => ({ status, body, event });
const toolIdOf = (params) => parseId(params[0]) ?? (() => { throw toolNotFound(); })();
const operatorIdOf = (params) => parseId(params[0]) ?? (() => { throw operatorNotFound(); })();

// Import ---------------------------------------------------------------------------

route('POST', /^\/admin\/import\/parse$/, 'admin', async ({ headers, bytes }) => ok(await parseImport(headers, bytes)), { raw: true });

route('POST', /^\/admin\/import\/diff$/, 'admin', ({ body }) => {
  const { rows } = bodyOf(body);
  assertRows(rows);
  return ok(computeDiff(existingTools(), rows));
}, { jsonLimit: ROWS_JSON_LIMIT });

route('POST', /^\/admin\/import\/commit$/, 'admin', ({ body }) => {
  const input = bodyOf(body);
  assertRows(input.rows);
  const mode = input.mode ?? 'merge';
  if (!IMPORT_MODES.includes(mode)) throw badRequest('VALIDATION', 'Modo de importación no válido (merge o replace).');
  const filename = typeof input.filename === 'string' ? input.filename : null;
  const result = commitImport(input.rows, { mode, filename });
  return ok(result, 200, broadcastLater('import'));
}, { jsonLimit: ROWS_JSON_LIMIT, mutates: true });

// Public ---------------------------------------------------------------------------

route('GET', /^\/health$/, null, () => ok({ ok: true, version: APP_VERSION, tools: db().tools.filter((t) => t.active === 1).length }));

route('GET', /^\/operators$/, null, () => ok({ operators: listActiveOperators() }));

route('POST', /^\/session$/, null, ({ body }) => {
  const input = bodyOf(body);
  const operatorId = parseId(input.operatorId);
  const operator = operatorId ? operatorById(operatorId) : null;
  if (!operator || operator.active !== 1) throw notFound('OPERATOR_NOT_FOUND', 'Ese operario no existe o está desactivado.');
  if (operator.pin) {
    const pin = pinInput(input.pin);
    if (!pin) throw unauthorized('PIN_REQUIRED', 'Introduce tu PIN.');
    verifyPin(`operator:${operator.id}`, pin, operator.pin, (attemptsLeft) =>
      unauthorized('PIN_INVALID', 'PIN incorrecto.', { attemptsLeft }),
    );
  }
  const token = createSession('operator', operator.id);
  return ok({ token, operator: { id: operator.id, name: operator.name } });
}, { mutates: true });

route('GET', /^\/admin\/state$/, null, () => ok({ configured: true }));

route('POST', /^\/admin\/setup$/, null, () => {
  throw conflict('ALREADY_CONFIGURED', 'El PIN de administración ya está configurado.');
});

route('POST', /^\/admin\/login$/, null, ({ body }) => {
  const pin = pinInput(bodyOf(body).pin);
  if (!pin) throw badRequest('PIN_REQUIRED', 'Introduce el PIN de administración.');
  verifyPin('admin', pin, db().adminPin, (attemptsLeft) =>
    unauthorized('PIN_INVALID', 'PIN de administración incorrecto.', { attemptsLeft }),
  );
  return ok({ token: createSession('admin') });
}, { mutates: true });

// Admin ----------------------------------------------------------------------------

route('POST', /^\/admin\/logout$/, 'admin', ({ session }) => {
  destroySession(session.token);
  return ok({ ok: true });
}, { mutates: true });

route('POST', /^\/admin\/pin$/, 'admin', ({ body, session }) => {
  const input = bodyOf(body);
  const currentPin = pinInput(input.currentPin);
  const newPin = pinInput(input.newPin);
  if (!currentPin) throw badRequest('PIN_REQUIRED', 'Introduce el PIN actual.');
  if (!ADMIN_PIN_RE.test(newPin)) throw badRequest('PIN_FORMAT', 'El PIN de administración debe tener entre 4 y 8 dígitos.');
  verifyPin('admin', currentPin, db().adminPin, (attemptsLeft) =>
    new DemoError(403, 'PIN_INVALID', 'El PIN actual no es correcto.', { attemptsLeft }),
  );
  const state = db();
  state.adminPin = newPin;
  state.sessions = state.sessions.filter((s) => s.kind !== 'admin' || s.token === session.token);
  return ok({ ok: true });
}, { mutates: true });

route('GET', /^\/admin\/summary$/, 'admin', () => ok(summary()));

route('GET', /^\/admin\/tools$/, 'admin', ({ query }) => {
  const status = query.get('status') || 'active';
  if (!TOOL_STATUSES.includes(status)) throw badRequest('VALIDATION', 'Filtro de estado no válido.');
  const offset = parseIntParam(query.get('offset'), { min: 0, max: 1e9, fallback: 0 });
  const limit = parseIntParam(query.get('limit'), { min: 1, max: 500, fallback: 100 });
  return ok(listTools({ q: queryText(query, 'q'), status, offset, limit }));
});

route('POST', /^\/admin\/tools$/, 'admin', ({ body }) => {
  const tool = createTool(bodyOf(body));
  return ok({ tool }, 201, broadcastLater('tools', [tool.id]));
}, { mutates: true });

route('PATCH', /^\/admin\/tools\/([^/]+)$/, 'admin', ({ params, body }) => {
  const id = toolIdOf(params);
  const tool = updateTool(id, bodyOf(body));
  return ok({ tool }, 200, broadcastLater('tools', [id]));
}, { mutates: true });

route('POST', /^\/admin\/tools\/([^/]+)\/force-return$/, 'admin', ({ params }) => {
  const id = toolIdOf(params);
  const result = forceReturn(id);
  return ok({ tool: result.tool }, 200, result.event ? broadcastLater(result.event, [id]) : null);
}, { mutates: true });

route('GET', /^\/admin\/operators$/, 'admin', () => ok({ operators: listAllOperators() }));

route('POST', /^\/admin\/operators$/, 'admin', ({ body }) => {
  const operator = createOperator(bodyOf(body));
  return ok({ operator }, 201, broadcastLater('operators'));
}, { mutates: true });

route('PATCH', /^\/admin\/operators\/([^/]+)$/, 'admin', ({ params, body }) => {
  const id = operatorIdOf(params);
  const { operator, deactivated, pinChanged } = updateOperator(id, bodyOf(body));
  if (deactivated || pinChanged) {
    const state = db();
    state.sessions = state.sessions.filter((s) => s.operatorId !== id);
  }
  return ok({ operator }, 200, broadcastLater('operators'));
}, { mutates: true });

route('POST', /^\/admin\/operators\/([^/]+)\/return-all$/, 'admin', ({ params }) => {
  const id = operatorIdOf(params);
  if (!operatorById(id)) throw operatorNotFound();
  const toolIds = forceReturnAllOf(id);
  return ok({ returned: toolIds.length, operator: getAdminOperator(id) }, 200, toolIds.length ? broadcastLater('return', toolIds) : null);
}, { mutates: true });

route('GET', /^\/admin\/history$/, 'admin', ({ query }) => {
  let operatorId = null;
  if (query.has('operatorId') && query.get('operatorId') !== '') {
    operatorId = parseId(query.get('operatorId'));
    if (!operatorId) throw badRequest('VALIDATION', 'Operario no válido.');
  }
  const offset = parseIntParam(query.get('offset'), { min: 0, max: 1e9, fallback: 0 });
  const limit = parseIntParam(query.get('limit'), { min: 1, max: 500, fallback: 50 });
  return ok(history({ q: queryText(query, 'q'), operatorId, offset, limit }));
});

route('GET', /^\/admin\/export\.csv$/, 'admin', () => {
  throw demoUnavailable();
});

route('GET', /^\/admin\/backup$/, 'admin', () => {
  throw demoUnavailable();
});

route('GET', /^\/admin\/server-info$/, 'admin', () => ok({ urls: [], qrSvg: null, version: APP_VERSION, demo: true }));

// Operator -------------------------------------------------------------------------

route('DELETE', /^\/session$/, 'operator', ({ session }) => {
  destroySession(session.token);
  return ok({ ok: true });
}, { mutates: true });

route('GET', /^\/me$/, 'operator', ({ session }) =>
  ok({
    operator: { id: session.operatorId, name: session.operatorName },
    inUseCount: countHeldBy(session.operatorId),
    pickCount: countPicks(session.operatorId),
  }),
);

route('GET', /^\/tools\/search$/, 'operator', ({ query, session }) => {
  const limit = parseIntParam(query.get('limit'), { min: 1, max: 100, fallback: 30 });
  return ok(searchTools(queryText(query, 'q'), { limit, viewerId: session.operatorId }));
});

route('GET', /^\/tools\/([^/]+)$/, 'operator', ({ params, session }) => {
  const id = toolIdOf(params);
  const tool = requireTool(id, session.operatorId);
  return ok({ tool: { ...tool, history: shortHistory(id, 5) } });
});

route('POST', /^\/tools\/([^/]+)\/checkout$/, 'operator', ({ params, body, session }) => {
  const id = toolIdOf(params);
  const { transfer, fromOperatorId } = bodyOf(body);
  if (transfer !== undefined && typeof transfer !== 'boolean') {
    throw badRequest('VALIDATION', 'El campo «transfer» debe ser verdadero o falso.');
  }
  let from = null;
  if (fromOperatorId !== undefined && fromOperatorId !== null) {
    from = parseId(fromOperatorId);
    if (!from) throw badRequest('VALIDATION', 'El campo «fromOperatorId» no es válido.');
  }
  const result = checkout(id, session.operatorId, { transfer: transfer === true, fromOperatorId: from });
  return ok({ tool: result.tool }, 200, result.event ? broadcastLater(result.event, [id]) : null);
}, { mutates: true });

route('POST', /^\/tools\/([^/]+)\/return$/, 'operator', ({ params, session }) => {
  const id = toolIdOf(params);
  const result = giveBack(id, session.operatorId);
  return ok({ tool: result.tool }, 200, result.event ? broadcastLater(result.event, [id]) : null);
}, { mutates: true });

route('GET', /^\/me\/tools$/, 'operator', ({ session }) => ok({ tools: heldBy(session.operatorId) }));

route('POST', /^\/me\/return$/, 'operator', ({ body, session }) => {
  const { toolIds } = bodyOf(body);
  let ids = null;
  if (toolIds !== undefined && toolIds !== null) {
    if (!Array.isArray(toolIds) || toolIds.length > MAX_RETURN_IDS) {
      throw badRequest('VALIDATION', 'La lista de útiles a devolver no es válida.');
    }
    ids = toolIds.map((value) => parseId(value));
    if (ids.some((id) => id === null)) throw badRequest('VALIDATION', 'La lista de útiles a devolver no es válida.');
  }
  const result = giveBackMany(session.operatorId, ids);
  return ok(result, 200, result.returned.length ? broadcastLater('return', result.returned.map((t) => t.id)) : null);
}, { mutates: true });

route('POST', /^\/me\/checkout$/, 'operator', ({ body, session }) => {
  const ids = pickIds(bodyOf(body).toolIds);
  const { taken, skipped, checkedOut } = checkoutMany(session.operatorId, ids);
  return ok({ taken, skipped }, 200, checkedOut.length ? broadcastLater('checkout', checkedOut) : null);
}, { mutates: true });

route('GET', /^\/me\/picklist$/, 'operator', ({ session }) => ok({ tools: listPicks(session.operatorId) }));

route('POST', /^\/me\/picklist$/, 'operator', ({ body, session }) => {
  const ids = pickIds(bodyOf(body).toolIds);
  const { added, skipped } = addPicks(session.operatorId, ids);
  return ok({ tools: listPicks(session.operatorId), skipped }, 200, added.length ? broadcastLater('picklist', added) : null);
}, { mutates: true });

route('DELETE', /^\/me\/picklist$/, 'operator', ({ session }) => {
  const removed = clearPicks(session.operatorId);
  return ok({ tools: [] }, 200, removed.length ? broadcastLater('picklist', removed) : null);
}, { mutates: true });

route('DELETE', /^\/me\/picklist\/([^/]+)$/, 'operator', ({ params, session }) => {
  const id = toolIdOf(params);
  const removed = removePick(session.operatorId, id);
  return ok({ tools: listPicks(session.operatorId) }, 200, removed ? broadcastLater('picklist', [id]) : null);
}, { mutates: true });

/** SSE change to send after the request (see ok()). */
function broadcastLater(type, toolIds = []) {
  return { type, toolIds };
}

// ---------------------------------------------------------------------------
// Dispatcher

function readJson(text, limit) {
  if (text.length > limit) throw new DemoError(413, 'PAYLOAD_TOO_LARGE', 'El archivo o la petición es demasiado grande.');
  if (!text) return undefined;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest('INVALID_JSON', 'La petición no tiene un formato JSON válido.');
  }
  if (!value || typeof value !== 'object') throw badRequest('INVALID_JSON', 'La petición no tiene un formato JSON válido.');
  return value;
}

/**
 * Handles one API request.
 * @param {{ method: string, path: string, query: URLSearchParams, headers: Headers,
 *   readBody: () => Promise<Uint8Array|null> }} request `path` is relative to /api
 * @returns {Promise<{ status: number, body?: object, headers?: object }>}
 */
export async function handle({ method, path, query, headers, readBody }) {
  let endChange = null;
  try {
    for (const def of routes) {
      if (def.method !== method) continue;
      const match = def.pattern.exec(path);
      if (!match) continue;
      const params = match.slice(1).map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          throw badRequest('BAD_REQUEST', 'La petición no es válida.');
        }
      });
      // Changes run one at a time, on the latest data (shared mode: under the lease of every
      // device); the response is sent once the change is applied in memory, while it is saved.
      if (def.mutates) endChange = await beginChange();
      const session = def.auth ? requireSession(headers, def.auth) : null;
      let body;
      let bytes = null;
      if (def.raw) {
        bytes = await readBody();
      } else if ((headers.get('content-type') ?? '').toLowerCase().includes('json')) {
        const raw = await readBody();
        body = readJson(raw ? new TextDecoder().decode(raw) : '', def.jsonLimit ?? JSON_LIMIT);
      }
      const result = await def.handler({ params, query, headers, body, bytes, session });
      if (def.mutates) save();
      if (result.event) broadcast(result.event.type, result.event.toolIds);
      return result;
    }
    throw notFound('NOT_FOUND', `Ruta de la API no encontrada: ${method} /api${path}`);
  } catch (err) {
    if (err instanceof DemoError) {
      // Rejected changes may still have touched sessions (expired ones are removed).
      return errorResponse(err);
    }
    console.error(err);
    return errorResponse(new DemoError(500, 'INTERNAL', 'Error interno del servidor. Inténtalo de nuevo.'));
  } finally {
    // Saves whatever the request changed, even when it was rejected (expired sessions).
    endChange?.().catch((err) => console.error(err));
  }
}
