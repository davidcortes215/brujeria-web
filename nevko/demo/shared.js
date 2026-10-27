// Shared demonstration data: the state of the demo backend kept in the artifact's `db`
// capability (a realtime JSON document store shared by every device where the published page
// is open), so the admin on the computer and the operators on their phones see the same data
// live. store.js uses it when `window.claude.use('db')` answers; otherwise the demo keeps its
// per-device mode (localStorage).
//
// Documents (collection `demo`, plus one lease document):
//   demo/meta                     { version, seededAt, adminPin, seq, rev, stamp, updatedAt,
//                                   updatedBy, shards: { operators: [docId], sessions: [...],
//                                   imports: [...], picklist: [...], tools: [...], checkouts: [...] } }
//   demo/<list>.<n>~<rev>.<tab>   { items: [...] }   chunk n of a list, under CHUNK_HARD_BYTES
//   locks/demo                    lease (acquire) that serialises the writers of every device
//
// Chunks are copy-on-write: a changed chunk is written as a new document, then meta points to
// the new set, then the documents meta no longer lists are deleted. A reader assembles the
// state only from the chunks listed in meta, so it never sees half of another device's change.
//
// Writers: every change runs under the lease (begin() -> apply in memory -> end()). begin()
// takes the lease (waiting up to LOCK_WAIT_MS while another device holds it), reads meta and,
// when another device wrote since, reloads everything before the change is applied. end()
// writes the chunks whose content changed (each to a new document) and then meta, and lets
// the lease expire a second later. Changes of one page run one after another; while the page
// still holds the lease from its previous change it skips the lease and meta round trips.
// Remote changes arrive through one collection subscription and replace the in-memory state.

import { STATE_VERSION, createSeedState, migrateState } from './seed.js';

/** Lists of the state, each stored in chunks. */
export const LISTS = ['operators', 'sessions', 'imports', 'picklist', 'tools', 'checkouts'];

/** Persisted fields of each list item, in a fixed order (derived search keys are left out). */
const FIELDS = {
  operators: ['id', 'name', 'pin', 'active', 'createdAt'],
  sessions: ['token', 'kind', 'operatorId', 'createdAt', 'lastSeenAt'],
  imports: ['id', 'filename', 'mode', 'createdAt', 'inserted', 'updated', 'unchanged', 'deactivated', 'reactivated'],
  picklist: ['operatorId', 'toolId', 'addedAt'],
  tools: ['id', 'code', 'location', 'description', 'active', 'createdAt', 'updatedAt'],
  checkouts: ['id', 'toolId', 'operatorId', 'takenAt', 'returnedAt', 'returnType', 'closedBy'],
};

const COLLECTION = 'demo';
const META_ID = 'meta';
const LOCK_PATH = 'locks/demo';

const USE_TIMEOUT_MS = 4000;
const LOCK_TTL_MS = 5000;
const LOCK_RELEASE_TTL_MS = 1000; // the shortest lease: "releases" it one second later
const LOCK_WAIT_MS = 4000;
const LOCK_RENEW_MARGIN_MS = 1500;
const CHUNK_HARD_BYTES = 160 * 1024; // documents are limited to 256 KiB
const CHUNK_SOFT_BYTES = 96 * 1024; // size of the chunks when a list is split again
const APPLY_DELAY_MS = 60;
const INCOMPLETE_RECHECK_MS = 3000;
const MAX_RESUBSCRIBES = 3;
const PARALLEL_WRITES = 4; // chunk documents written at the same time (different documents)

/** Codes that no retry can fix: the demo continues on this device only. */
const FATAL_CODES = new Set([
  'invalid_argument',
  'quota_exceeded',
  'revoked',
  'not_granted',
  'capability_disabled',
  'capability_removed',
  'transform_error',
  'newer_version',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const byteLength = (text) => encoder.encode(text).length;
const codeOf = (err) => (err && typeof err.code === 'string' ? err.code : 'unavailable');

function randomId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/** Error with a db-like code ({ code, message }). */
export function sharedError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Spanish explanation of a db failure (first sentence of the notice shown to the user). */
export function sharedFailureMessage(err) {
  switch (codeOf(err)) {
    case 'quota_exceeded':
      return 'El espacio de datos compartidos de la demostración está lleno.';
    case 'invalid_argument':
    case 'transform_error':
      return 'Los datos compartidos no admiten este cambio.';
    case 'revoked':
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return 'Esta página ya no tiene acceso a los datos compartidos.';
    case 'newer_version':
      return 'Se ha abierto una versión más reciente de la demostración en otro dispositivo.';
    default:
      return 'No se ha podido conectar con los datos compartidos.';
  }
}

/** Runs a db call; a transient failure is retried once after a short random pause. */
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const code = codeOf(err);
    if (FATAL_CODES.has(code)) throw err;
    await sleep((code === 'resource_exhausted' ? 1200 : 250) + Math.floor(Math.random() * 400));
    return fn();
  }
}

/**
 * The `db` namespace of the viewer, or null: no `window.claude` (a plain copy of the page),
 * the capability is not served here, or no answer within `timeoutMs`.
 */
export async function openDb(timeoutMs = USE_TIMEOUT_MS) {
  let request;
  try {
    const claude = window.claude;
    if (!claude || typeof claude.use !== 'function') return null;
    request = Promise.resolve(claude.use('db')).catch(() => null);
  } catch {
    return null;
  }
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const ns = await Promise.race([request, timeout]);
    return ns && typeof ns.collection === 'function' && typeof ns.doc === 'function' ? ns : null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// State <-> documents

/** Copy of a list item with only its persisted fields, in a fixed order. */
function pick(list, item) {
  const out = {};
  for (const field of FIELDS[list]) {
    const value = item && typeof item === 'object' ? item[field] : undefined;
    out[field] = value === undefined ? null : value;
  }
  return out;
}

/** Plain copy of a state (persisted fields only): what the documents hold. */
export function plainState(state) {
  const out = {
    version: state.version,
    seededAt: state.seededAt,
    adminPin: state.adminPin,
    seq: { ...state.seq },
  };
  for (const list of LISTS) out[list] = (state[list] ?? []).map((item) => pick(list, item));
  return out;
}

/** Text that is equal for two states with the same persisted data. */
export function fingerprint(state) {
  return JSON.stringify(plainState({ ...state, seededAt: null }));
}

const headOf = (source) => ({
  version: source.version,
  seededAt: source.seededAt ?? null,
  adminPin: source.adminPin,
  seq: {
    tool: Number(source.seq?.tool) || 0,
    operator: Number(source.seq?.operator) || 0,
    checkout: Number(source.seq?.checkout) || 0,
    import: Number(source.seq?.import) || 0,
  },
});

const revOf = (docId) => {
  const match = /~(\d+)\./.exec(docId);
  return match ? Number(match[1]) : null;
};

/**
 * Chunk ranges [from, to) of a list: the previous item counts are kept while every chunk stays
 * under CHUNK_HARD_BYTES (appending only grows the last chunk); from the first chunk that grew
 * too big, the rest is packed again into chunks of about CHUNK_SOFT_BYTES.
 */
function packRanges(jsons, previousCounts) {
  const sizes = jsons.map((json) => byteLength(json) + 1);
  const bytes = (from, to) => {
    let total = 16;
    for (let i = from; i < to; i++) total += sizes[i];
    return total;
  };
  const greedy = (from) => {
    const ranges = [];
    let start = from;
    let size = 16;
    for (let i = from; i < jsons.length; i++) {
      if (i > start && size + sizes[i] > CHUNK_SOFT_BYTES) {
        ranges.push([start, i]);
        start = i;
        size = 16;
      }
      size += sizes[i];
    }
    ranges.push([start, jsons.length]);
    return ranges;
  };
  if (!previousCounts?.length) return greedy(0);
  const ranges = [];
  let at = 0;
  previousCounts.forEach((count, index) => {
    const end = index === previousCounts.length - 1 ? jsons.length : Math.min(jsons.length, at + count);
    if (end > at || ranges.length === 0) ranges.push([at, end]);
    at = end;
  });
  const bad = ranges.findIndex(([from, to]) => bytes(from, to) > CHUNK_HARD_BYTES);
  return bad < 0 ? ranges : [...ranges.slice(0, bad), ...greedy(ranges[bad][0])];
}

function validHead(meta) {
  return (
    typeof meta.adminPin === 'string' &&
    meta.seq &&
    typeof meta.seq === 'object' &&
    ['tool', 'operator', 'checkout', 'import'].every((key) => Number.isFinite(meta.seq[key])) &&
    meta.shards &&
    typeof meta.shards === 'object'
  );
}

/**
 * Builds the state from the documents of the collection (Map id -> body).
 * status: 'ok' | 'migrated' (an older STATE_VERSION, brought up to date with migrateState():
 * every record kept) | 'empty' (no meta) | 'newer' (a later STATE_VERSION) | 'invalid' |
 * 'incomplete' (meta lists a chunk that has not arrived yet).
 */
function assemble(docs) {
  const meta = docs.get(META_ID);
  if (!meta) return { status: 'empty' };
  if (typeof meta.version === 'number' && meta.version > STATE_VERSION) return { status: 'newer', meta };
  const older = Number.isInteger(meta.version) && meta.version >= 1 && meta.version < STATE_VERSION;
  if (meta.version !== STATE_VERSION && !older) return { status: 'invalid', meta };
  if (!validHead(meta) || typeof meta.rev !== 'number' || typeof meta.stamp !== 'string') return { status: 'invalid', meta };
  const state = headOf(meta);
  const chunks = {};
  for (const list of LISTS) {
    // A list that an older version did not have yet starts empty.
    const ids = meta.shards[list] === undefined && older ? [] : meta.shards[list];
    if (!Array.isArray(ids)) return { status: 'invalid', meta };
    state[list] = [];
    chunks[list] = [];
    for (const id of ids) {
      const body = docs.get(id);
      if (!body) return { status: 'incomplete', meta };
      if (!Array.isArray(body.items)) return { status: 'invalid', meta };
      const items = body.items.map((item) => pick(list, item));
      for (const item of items) state[list].push(item);
      chunks[list].push({ id, json: JSON.stringify(items), count: items.length });
    }
  }
  if (older) {
    const migrated = migrateState(state);
    return migrated ? { status: 'migrated', meta, state: plainState(migrated), chunks } : { status: 'invalid', meta };
  }
  return { status: 'ok', meta, state, chunks };
}

// ---------------------------------------------------------------------------
// Sync

/**
 * One connection of this page to the shared data.
 * hooks: getState() -> current in-memory state; setState(plain, { remote }) replaces it
 * (remote: another device changed it); onFatal(err) -> the demo continues on this device only.
 */
export class SharedSync {
  constructor(ns, hooks) {
    this.hooks = hooks;
    this.tab = randomId();
    this.col = ns.collection(COLLECTION);
    this.metaRef = this.col.doc(META_ID);
    this.lockRef = ns.doc(LOCK_PATH);
    this.active = true;
    this.known = null; // { rev, stamp, head, shards, chunks } of the shared data this page holds
    this.serverRev = 0;
    this.forceFull = false;
    this.docs = new Map(); // last collection snapshot: id -> body
    this.snapMeta = { fromCache: true, hasPendingWrites: false };
    this.unsubscribe = null;
    this.resubscribes = 0;
    this.chain = Promise.resolve();
    this.busy = 0; // changes queued or running: remote snapshots wait
    this.waiting = 0;
    this.locked = false;
    this.heldUntil = 0;
    this.applyTimer = null;
    this.recheckTimer = null;
    this.cleanup = Promise.resolve();
  }

  /**
   * Loads the shared data, or creates it from `localState` (this device's own demo data) or the
   * sample data when the store is empty. Shared data of an older version is migrated in place
   * and written back (every record kept); damaged or incomplete data is never replaced
   * automatically (it may hold the user's real data): the demo then goes on locally. Subscribes
   * to changes. Resolves { state, seededFromLocal }; rejects with the db error.
   */
  async start({ localState = null } = {}) {
    this.busy++;
    try {
      let docs = await this.readAll();
      let found = assemble(docs);
      if (found.status === 'newer') throw sharedError('newer_version');
      let result;
      if (found.status === 'ok') {
        result = { state: found.state, seededFromLocal: false };
        this.adopt(found, { emit: false });
      } else {
        // Empty, older version or not readable yet: one device creates / migrates it, under the lease.
        this.locked = await this.lock();
        try {
          docs = await this.readAll();
          found = assemble(docs);
          for (let retry = 0; found.status === 'incomplete' && retry < 2; retry++) {
            await sleep(700);
            docs = await this.readAll();
            found = assemble(docs);
          }
          if (found.status === 'newer') throw sharedError('newer_version');
          if (found.status === 'ok') {
            result = { state: found.state, seededFromLocal: false };
            this.adopt(found, { emit: false });
          } else if (found.status === 'migrated' || found.status === 'empty') {
            const fromLocal = found.status === 'empty' && Boolean(localState);
            let next = found.state;
            if (found.status === 'empty') next = plainState(fromLocal ? localState : createSeedState());
            this.docs = docs;
            this.serverRev = Math.max(this.serverRev, Number(found.meta?.rev) || 0);
            await this.write(next, { full: true });
            result = { state: next, seededFromLocal: fromLocal };
          } else {
            // Damaged or still incomplete: never replaced automatically.
            throw sharedError('unavailable', `shared data ${found.status}`);
          }
        } finally {
          await this.unlock();
        }
      }
      if (!this.active) throw sharedError('unavailable');
      this.subscribe();
      return result;
    } finally {
      this.busy--;
    }
  }

  /** Stops syncing (the page continues on this device only). */
  stop() {
    this.active = false;
    clearTimeout(this.applyTimer);
    clearTimeout(this.recheckTimer);
    try {
      this.unsubscribe?.();
    } catch {
      // already closed
    }
    this.unsubscribe = null;
  }

  fail(err) {
    if (!this.active) return;
    this.stop();
    this.hooks.onFatal(err);
  }

  /**
   * Starts a change: waits for this page's previous changes, takes the lease and makes the
   * in-memory state current. Resolves end(): writes what changed (resolves when written).
   */
  async begin() {
    this.busy++;
    let done;
    const turn = new Promise((resolve) => {
      done = resolve;
    });
    const previous = this.chain;
    this.chain = previous.then(() => turn);
    this.waiting++;
    await previous;
    this.waiting--;
    const finish = () => {
      this.busy--;
      done();
      this.scheduleApply(0);
    };
    if (!this.active) {
      finish();
      return async () => {};
    }
    try {
      // Still holding the lease since this page's previous change: nobody else wrote meanwhile.
      if (!this.locked || performance.now() >= this.heldUntil - LOCK_RENEW_MARGIN_MS) {
        this.locked = await this.lock();
        await this.refresh();
      }
    } catch (err) {
      finish();
      this.fail(err);
      return async () => {};
    }
    let ended = false;
    return async () => {
      if (ended) return;
      ended = true;
      try {
        if (this.active) await this.write(this.hooks.getState(), { full: this.forceFull });
        this.forceFull = false;
      } catch (err) {
        this.fail(err);
      } finally {
        if (this.waiting === 0) await this.unlock();
        finish();
      }
    };
  }

  /** Replaces the shared data with `plain` (reset, upload). Resolves false when it failed. */
  async replaceAll(plain) {
    const end = await this.begin();
    if (!this.active) {
      await end();
      return false;
    }
    this.hooks.setState(plain, { remote: false });
    this.forceFull = true;
    await end();
    return this.active;
  }

  // Lease --------------------------------------------------------------------------

  async lock() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let delay = 150;
    for (;;) {
      const startedAt = performance.now();
      const result = await withRetry(() => this.lockRef.acquire({ holder: this.tab, ttlMs: LOCK_TTL_MS }));
      if (result?.acquired) {
        this.heldUntil = startedAt + LOCK_TTL_MS;
        return true;
      }
      // Busy: another device is writing. After LOCK_WAIT_MS go on without the lease.
      if (Date.now() + delay > deadline) return false;
      await sleep(delay + Math.floor(Math.random() * 100));
      delay = Math.min(400, Math.round(delay * 1.4));
    }
  }

  async renewLock() {
    if (!this.locked || performance.now() < this.heldUntil - LOCK_RENEW_MARGIN_MS) return;
    const startedAt = performance.now();
    const result = await withRetry(() => this.lockRef.acquire({ holder: this.tab, ttlMs: LOCK_TTL_MS }));
    if (result?.acquired) this.heldUntil = startedAt + LOCK_TTL_MS;
    else this.locked = false;
  }

  /** Leases cannot be released: the shortest renewal lets it expire a second later. */
  async unlock() {
    if (!this.locked) return;
    this.locked = false;
    this.heldUntil = 0;
    try {
      await this.lockRef.acquire({ holder: this.tab, ttlMs: LOCK_RELEASE_TTL_MS });
    } catch {
      // it expires on its own
    }
  }

  // Reading ------------------------------------------------------------------------

  /**
   * Reads from the store, repeating a read it marks as not server-definitive (fromCache): an
   * empty cached view must never make this page create the shared data again.
   */
  async definitive(read) {
    for (let attempt = 0; ; attempt++) {
      const snap = await withRetry(read);
      if (!snap?.metadata?.fromCache) return snap;
      if (attempt >= 2) throw sharedError('unavailable', 'no server-definitive read');
      await sleep(400);
    }
  }

  /** Every document of the collection: Map id -> body. */
  async readAll() {
    const snap = await this.definitive(() => this.col.get());
    const docs = new Map();
    for (const doc of snap.docs) if (doc.exists) docs.set(doc.id, doc.data());
    return docs;
  }

  /** Under the lease: reloads the shared data when another device changed it. */
  async refresh() {
    const snap = await this.definitive(() => this.metaRef.get());
    const meta = snap?.exists ? snap.data() : null;
    if (!meta) {
      this.forceFull = true; // deleted: write this page's data again
      return;
    }
    if (typeof meta.rev === 'number') this.serverRev = Math.max(this.serverRev, meta.rev);
    if (typeof meta.version === 'number' && meta.version > STATE_VERSION) throw sharedError('newer_version');
    if (this.known && meta.stamp === this.known.stamp && meta.version === STATE_VERSION) return;
    let docs = await this.readAll();
    let found = assemble(docs);
    if (found.status === 'incomplete') {
      await sleep(500);
      docs = await this.readAll();
      found = assemble(docs);
    }
    if (found.status === 'newer') throw sharedError('newer_version');
    if (found.status === 'ok' || found.status === 'migrated') this.adopt(found, { emit: true });
    // Migrated (this change writes it back at the current version) or not readable: write everything.
    if (found.status !== 'ok') this.forceFull = true;
  }

  adopt(found, { emit }) {
    const { meta } = found;
    this.known = {
      rev: meta.rev,
      stamp: meta.stamp,
      head: headOf(meta),
      shards: Object.fromEntries(LISTS.map((list) => [list, [...meta.shards[list]]])),
      chunks: found.chunks,
    };
    this.serverRev = Math.max(this.serverRev, meta.rev);
    this.hooks.setState(found.state, { remote: emit });
  }

  // Writing ------------------------------------------------------------------------

  /** Documents to write for `state`; null when the shared data already holds it. */
  plan(state, full) {
    const previous = full ? null : this.known;
    const rev = Math.max(this.known?.rev ?? 0, this.serverRev) + 1;
    const stamp = `${rev}.${this.tab}`;
    const shards = {};
    const chunks = {};
    const writes = [];
    for (const list of LISTS) {
      const items = (state[list] ?? []).map((item) => pick(list, item));
      const jsons = items.map((item) => JSON.stringify(item));
      const before = previous?.chunks[list] ?? null;
      const ranges = packRanges(jsons, before?.map((chunk) => chunk.count));
      shards[list] = [];
      chunks[list] = [];
      ranges.forEach(([from, to], index) => {
        const json = `[${jsons.slice(from, to).join(',')}]`;
        const old = before?.[index];
        let id;
        if (old && old.json === json) {
          id = old.id;
        } else {
          id = `${list}.${index}~${stamp}`;
          writes.push({ id, items: items.slice(from, to) });
        }
        shards[list].push(id);
        chunks[list].push({ id, json, count: to - from });
      });
    }
    const head = headOf(state);
    if (previous && !writes.length && JSON.stringify(head) === JSON.stringify(previous.head) && JSON.stringify(shards) === JSON.stringify(previous.shards)) {
      return null;
    }
    const meta = { ...head, rev, stamp, updatedAt: new Date().toISOString(), updatedBy: this.tab, shards };
    return { meta, writes, known: { rev, stamp, head, shards, chunks } };
  }

  /**
   * Writes the changed chunks (new documents, a few at a time), then meta; cleans up
   * afterwards. Each document is written once.
   */
  async write(state, { full = false } = {}) {
    const plan = this.plan(state, full);
    if (!plan) return false;
    for (let at = 0; at < plan.writes.length; at += PARALLEL_WRITES) {
      if (!this.active) return false;
      await this.renewLock();
      const batch = plan.writes.slice(at, at + PARALLEL_WRITES);
      await Promise.all(batch.map(({ id, items }) => withRetry(() => this.col.doc(id).set({ items }))));
    }
    if (!this.active) return false;
    await this.renewLock();
    await withRetry(() => this.metaRef.set(plan.meta));
    const before = this.known;
    this.known = plan.known;
    this.serverRev = Math.max(this.serverRev, plan.known.rev);
    this.removeUnused(before, plan.known);
    return true;
  }

  /** Deletes (in the background) the chunks meta no longer lists and older leftovers. */
  removeUnused(before, now) {
    const keep = new Set(Object.values(now.shards).flat());
    const limit = before?.rev ?? now.rev - 1;
    const doomed = new Set();
    for (const id of Object.values(before?.shards ?? {}).flat()) if (!keep.has(id)) doomed.add(id);
    for (const id of this.docs.keys()) {
      if (id === META_ID || keep.has(id)) continue;
      const rev = revOf(id);
      if (rev !== null && rev <= limit) doomed.add(id);
    }
    if (!doomed.size) return;
    this.cleanup = this.cleanup.then(async () => {
      for (const id of doomed) {
        if (!this.active) return;
        try {
          await this.col.doc(id).delete();
        } catch {
          // left for the next write to delete
        }
      }
    });
  }

  // Remote changes -------------------------------------------------------------------

  subscribe() {
    if (!this.active || this.unsubscribe) return;
    try {
      this.unsubscribe = this.col.onSnapshot(
        (snap) => this.onSnapshot(snap),
        (err) => this.onSnapshotError(err),
      );
    } catch (err) {
      this.onSnapshotError(err);
    }
  }

  onSnapshot(snap) {
    if (!this.active) return;
    const docs = new Map();
    for (const doc of snap.docs) if (doc.exists) docs.set(doc.id, doc.data());
    this.docs = docs;
    this.snapMeta = snap.metadata ?? { fromCache: false, hasPendingWrites: false };
    this.resubscribes = 0;
    this.scheduleApply(APPLY_DELAY_MS);
  }

  onSnapshotError(err) {
    if (!this.active) return;
    this.unsubscribe = null;
    const code = codeOf(err);
    if (FATAL_CODES.has(code) || ++this.resubscribes > MAX_RESUBSCRIBES) {
      this.fail(err);
      return;
    }
    setTimeout(() => this.subscribe(), 1000 * this.resubscribes);
  }

  /** Runs applyRemote() soon; a stream of snapshots does not postpone it indefinitely. */
  scheduleApply(ms) {
    if (!this.active || this.applyTimer) return;
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      this.applyRemote();
    }, ms);
  }

  /** Adopts the last snapshot when another device wrote a newer revision. */
  applyRemote() {
    if (!this.active || this.busy) return;
    const meta = this.docs.get(META_ID);
    if (!meta || this.snapMeta.hasPendingWrites) return;
    if (typeof meta.version === 'number' && meta.version > STATE_VERSION) {
      this.fail(sharedError('newer_version'));
      return;
    }
    if (!Number.isInteger(meta.version) || meta.version < 1 || typeof meta.rev !== 'number') return;
    if (this.known) {
      if (meta.stamp === this.known.stamp) return;
      if (meta.rev < this.known.rev || (meta.rev === this.known.rev && this.snapMeta.fromCache)) return;
    }
    const found = assemble(this.docs);
    if (found.status === 'ok') {
      this.adopt(found, { emit: true });
    } else if (found.status === 'migrated') {
      // Written by a page of an older version: adopted, and the next change writes it back.
      this.adopt(found, { emit: true });
      this.forceFull = true;
    } else if (found.status === 'incomplete') {
      this.scheduleRecheck();
    }
  }

  /** A chunk listed in meta did not arrive: read everything again a little later. */
  scheduleRecheck() {
    if (this.recheckTimer) return;
    this.recheckTimer = setTimeout(async () => {
      this.recheckTimer = null;
      if (!this.active) return;
      const end = await this.exclusive();
      try {
        if (!this.active) return;
        const meta = this.docs.get(META_ID);
        if (!meta || (this.known && meta.stamp === this.known.stamp)) return;
        const found = assemble(await this.readAll());
        const usable = found.status === 'ok' || found.status === 'migrated';
        if (usable && (!this.known || found.meta.stamp !== this.known.stamp)) this.adopt(found, { emit: true });
        if (found.status === 'migrated') this.forceFull = true;
      } catch (err) {
        if (FATAL_CODES.has(codeOf(err))) this.fail(err);
      } finally {
        end();
      }
    }, INCOMPLETE_RECHECK_MS);
  }

  /** Waits for this page's changes and blocks new ones until the returned function is called. */
  async exclusive() {
    this.busy++;
    let done;
    const turn = new Promise((resolve) => {
      done = resolve;
    });
    const previous = this.chain;
    this.chain = previous.then(() => turn);
    await previous;
    return () => {
      this.busy--;
      done();
      this.scheduleApply(0);
    };
  }
}
