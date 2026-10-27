// Initial data of the demonstration: the sample catalogue (samples/utillaje-ejemplo.pdf,
// generated into seed-data.js by scripts/build-demo.js), eight operators, tools in use,
// two weeks of history and a few tools marked to be taken (pick lists). Times are relative to the moment the demo is (re)seeded;
// everything else is deterministic, so every reset looks the same.

import { SEED_TOOLS } from './seed-data.js';

// Version of the saved state (localStorage and the shared `db` documents):
//   1: tools, operators, loans, sessions, imports.   2: pick lists (picklist).
// Several units of one code (2026-09) need no change of the state: they are just tools.
// A saved state of an OLDER version is migrated in place (migrateState: every record is kept,
// it is never replaced by the sample data); a newer one is left alone (store.js / shared.js).
export const STATE_VERSION = 2;
export const ADMIN_PIN = '2468';

const MINUTE = 60_000;

/** [name, PIN or null] — ids follow this order. */
const OPERATORS = [
  ['Ana López', null],
  ['Juan Pérez', '1234'],
  ['Carlos Martín', null],
  ['Lucía Fernández', null],
  ['Miguel Ángel Ruiz', null],
  ['Sergio Gómez', null],
  ['Elena Navarro', null],
  ['Javier Torres', null],
];

/** Open loans: [operator, tool code, minutes ago]. */
const IN_USE = [
  ['Juan Pérez', 'UT-0047', 30 * 60 + 5],
  ['Juan Pérez', 'LLV-043', 4 * 60 + 10],
  ['Juan Pérez', 'GAL-H7-041', 2 * 60 + 50],
  ['Juan Pérez', 'M-8756', 47],
  ['Carlos Martín', 'PLT 315-B', 9 * 60 + 20],
  ['Carlos Martín', 'UE-2037', 3 * 60 + 40],
  ['Carlos Martín', 'SOP-24', 95],
  ['Lucía Fernández', 'CAL-148', 5 * 60 + 15],
  ['Lucía Fernández', 'EXT/113', 12],
];

/** Pick lists: [operator, tool code, minutes ago]. Free tools; Ana's are in two zones. */
const PICKS = [
  ['Ana López', 'CAL-071', 26],
  ['Ana López', 'UT-1068', 25],
  ['Ana López', 'GAL-H7-069', 24],
  ['Juan Pérez', 'PLT 104-B', 52],
];

/** Tools that appear often in the history (the rest of the catalogue is picked at random). */
const FREQUENT = ['CAL-009', 'CAL-061', 'GAL-H7-041', 'UT-0047', 'LLV-002', 'M-8034', 'PLT 104-B', 'UE-1122', 'SOP-02', 'EXT/011'];

const HISTORY_TARGET = 60;

/** Small deterministic PRNG (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local date at hh:mm, `daysAgo` calendar days before `now`. */
function localTime(now, daysAgo, hours, minutes) {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Builds a fresh demo state.
 * @param {number} [now] reference time (ms)
 */
export function createSeedState(now = Date.now()) {
  const rnd = random(20260927);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const createdAt = iso(localTime(now, 35, 8, 12));

  const tools = SEED_TOOLS.map(([code, location, description], index) => ({
    id: index + 1,
    code,
    location,
    description,
    active: 1,
    createdAt,
    updatedAt: createdAt,
  }));
  const toolByCode = new Map(tools.map((tool) => [tool.code, tool]));

  const operators = OPERATORS.map(([name, pin], index) => ({
    id: index + 1,
    name,
    pin,
    active: 1,
    createdAt,
  }));
  const operatorByName = new Map(operators.map((op) => [op.name, op]));

  // Busy periods per tool, so that one tool never has two loans at the same time.
  const busy = new Map();
  const isFree = (toolId, from, to) => !(busy.get(toolId) ?? []).some(([a, b]) => from < b && to > a);
  const markBusy = (toolId, from, to) => busy.set(toolId, [...(busy.get(toolId) ?? []), [from, to]]);

  const rows = []; // { toolId, operatorId, takenAt, returnedAt, returnType, closedBy } in ms

  // Open loans.
  for (const [name, code, minutesAgo] of IN_USE) {
    const tool = toolByCode.get(code);
    const operator = operatorByName.get(name);
    if (!tool || !operator) continue;
    const takenAt = now - minutesAgo * MINUTE;
    markBusy(tool.id, takenAt, Infinity);
    rows.push({ toolId: tool.id, operatorId: operator.id, takenAt, returnedAt: null, returnType: null, closedBy: null });
  }

  // History: working days from two days ago backwards.
  const frequent = FREQUENT.map((code) => toolByCode.get(code)).filter(Boolean);
  const regulars = operators.slice(0, 6);
  let history = 0;
  for (let daysAgo = 2; daysAgo < 30 && history < HISTORY_TARGET; daysAgo++) {
    const weekday = new Date(localTime(now, daysAgo, 12, 0)).getDay();
    if (weekday === 0 || weekday === 6) continue;
    const loans = 4 + Math.floor(rnd() * 4);
    for (let n = 0; n < loans && history < HISTORY_TARGET; n++) {
      const operator = rnd() < 0.8 ? pick(regulars) : pick(operators);
      const start = localTime(now, daysAgo, 6, 30) + Math.floor(rnd() * 8.5 * 60) * MINUTE;
      const kind = rnd();
      let placed = false;
      for (let attempt = 0; attempt < 8 && !placed; attempt++) {
        const tool = rnd() < 0.45 ? pick(frequent) : pick(tools);
        if (kind < 0.12) {
          // Handed over to another operator ("Me lo ha pasado"), who then puts it away.
          const other = pick(regulars.filter((op) => op.id !== operator.id));
          const handover = start + (30 + Math.floor(rnd() * 90)) * MINUTE;
          const end = handover + (20 + Math.floor(rnd() * 150)) * MINUTE;
          if (!isFree(tool.id, start, end)) continue;
          markBusy(tool.id, start, end);
          rows.push({ toolId: tool.id, operatorId: operator.id, takenAt: start, returnedAt: handover, returnType: 'transferred', closedBy: other.id });
          rows.push({ toolId: tool.id, operatorId: other.id, takenAt: handover, returnedAt: end, returnType: 'returned', closedBy: other.id });
          history += 2;
        } else if (kind < 0.18) {
          // Forgotten and marked as put away by the administration the next morning.
          const end = localTime(now, daysAgo - 1, 7, 5) + Math.floor(rnd() * 40) * MINUTE;
          if (!isFree(tool.id, start, end)) continue;
          markBusy(tool.id, start, end);
          rows.push({ toolId: tool.id, operatorId: operator.id, takenAt: start, returnedAt: end, returnType: 'forced', closedBy: null });
          history += 1;
        } else {
          const end = Math.min(start + (15 + Math.floor(rnd() * 300)) * MINUTE, localTime(now, daysAgo, 18, 40));
          if (!isFree(tool.id, start, end)) continue;
          markBusy(tool.id, start, end);
          rows.push({ toolId: tool.id, operatorId: operator.id, takenAt: start, returnedAt: end, returnType: 'returned', closedBy: operator.id });
          history += 1;
        }
        placed = true;
      }
    }
  }

  rows.sort((a, b) => a.takenAt - b.takenAt || a.toolId - b.toolId);
  const checkouts = rows.map((row, index) => ({
    id: index + 1,
    toolId: row.toolId,
    operatorId: row.operatorId,
    takenAt: iso(row.takenAt),
    returnedAt: row.returnedAt === null ? null : iso(row.returnedAt),
    returnType: row.returnType,
    closedBy: row.closedBy,
  }));

  const picklist = [];
  for (const [name, code, minutesAgo] of PICKS) {
    const tool = toolByCode.get(code);
    const operator = operatorByName.get(name);
    if (!tool || !operator || !isFree(tool.id, now, Infinity)) continue; // only tools nobody holds
    picklist.push({ operatorId: operator.id, toolId: tool.id, addedAt: iso(now - minutesAgo * MINUTE) });
  }

  const imports = [
    {
      id: 1,
      filename: 'utillaje-ejemplo.pdf',
      mode: 'merge',
      createdAt,
      inserted: tools.length,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
      reactivated: 0,
    },
  ];

  return {
    version: STATE_VERSION,
    seededAt: iso(now),
    adminPin: ADMIN_PIN,
    seq: { tool: tools.length, operator: operators.length, checkout: checkouts.length, import: imports.length },
    tools,
    operators,
    checkouts,
    sessions: [],
    imports,
    picklist,
  };
}

/**
 * Builds a demo state without tools, loans, lists or imports (the sample operators stay),
 * for trying a real catalogue.
 * @param {number} [now] reference time (ms)
 */
export function createEmptyState(now = Date.now()) {
  const seed = createSeedState(now);
  return {
    ...seed,
    seq: { ...seed.seq, tool: 0, checkout: 0, import: 0 },
    tools: [],
    checkouts: [],
    imports: [],
    picklist: [],
  };
}


// Steps of migrateState(): MIGRATIONS[v] turns a state of version v into version v + 1 (in place).
const MIGRATIONS = {
  1: (state) => {
    state.picklist = Array.isArray(state.picklist) ? state.picklist : [];
  },
};

/**
 * Brings a saved state of an older version up to STATE_VERSION, keeping every record (a copy:
 * the input is not changed). Returns the state (the same object when it is already current),
 * or null when it is not a demo state or belongs to a newer version.
 */
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.version)) return null;
  if (raw.version === STATE_VERSION) return raw;
  if (raw.version > STATE_VERSION || raw.version < 1) return null;
  const state = { ...raw };
  for (let version = raw.version; version < STATE_VERSION; version++) {
    MIGRATIONS[version]?.(state);
    state.version = version + 1;
  }
  return state;
}
