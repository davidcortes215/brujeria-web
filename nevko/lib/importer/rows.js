// Import rows against the catalogue, without database access (pure module, shared by
// importer/sync.js and the browser demo): row cleaning, pairing with the existing tools
// and the diff summary (SPEC §5 import/diff).

import { FIELD_LIMITS } from '../limits.js';
import { cleanText, codeKey, codeNorm, naturalCompare, textNorm } from '../normalize.js';

export const MAX_IMPORT_ROWS = 50_000;
export const MAX_DIFF_CHANGES = 500;
export const IMPORT_MODES = Object.freeze(['merge', 'replace']);

const FIELD_LABELS = { location: 'La ubicación', description: 'La descripción' };

const asText = (value) => (typeof value === 'string' || typeof value === 'number' ? cleanText(value) : '');

/** Cuts a text to `limit` UTF-16 units without leaving half a surrogate pair. */
const truncate = (text, limit) => text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '').trimEnd();

/**
 * Cleans the incoming rows. Rows with the same code (same code key) are several UNITS of that
 * code (three identical sets, a spare one on order), kept in file order.
 * A location or description over its limit is cut and reported, not rejected: the code is
 * valid, so the tool is in the file (replace mode must not retire it).
 * Returns { groups: Map<codeKey, row[]> (first occurrence order; rows in file order, each with
 * its file `index`), count (valid rows), invalid: [{ index, reason, code? }],
 * multiUnit: [{ code, count }] (codes with several units, as written in their first row),
 * truncated: [{ index, code, fields, message }], similar: [[code, code, ...]] } where
 * `similar` groups different codes of the file that are the same code written differently.
 */
export function prepareRows(rows) {
  const groups = new Map();
  const invalid = [];
  const truncated = [];
  let count = 0;
  rows.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      invalid.push({ index, reason: 'Fila no válida.' });
      return;
    }
    const row = { code: asText(raw.code), location: asText(raw.location), description: asText(raw.description) };
    let reason = null;
    if (!row.code) reason = 'Fila sin código.';
    else if (row.code.length > FIELD_LIMITS.code) reason = `El código supera los ${FIELD_LIMITS.code} caracteres.`;
    else if (!codeNorm(row.code)) reason = 'El código no contiene letras ni números.';
    if (reason) {
      invalid.push({ index, reason, code: row.code || undefined });
      return;
    }
    const cut = ['location', 'description'].filter((field) => row[field].length > FIELD_LIMITS[field]);
    if (cut.length) {
      for (const field of cut) row[field] = truncate(row[field], FIELD_LIMITS[field]);
      const message = cut
        .map((field) => `${FIELD_LABELS[field]} supera los ${FIELD_LIMITS[field]} caracteres y se ha recortado.`)
        .join(' ');
      truncated.push({ index, code: row.code, fields: cut, message });
    }
    const key = codeKey(row.code);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...row, index });
    count++;
  });
  const multiUnit = [...groups.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({ code: list[0].code, count: list.length }));
  const byNorm = new Map();
  for (const list of groups.values()) {
    const norm = codeNorm(list[0].code);
    byNorm.set(norm, [...(byNorm.get(norm) ?? []), list[0].code]);
  }
  const similar = [...byNorm.values()].filter((codes) => codes.length > 1);
  return { groups, count, invalid, multiUnit, truncated, similar };
}

// Candidates for a file row: active units first, then those in use, then the oldest.
const candidateOrder = (a, b) => b.active - a.active || b.inUse - a.inUse || a.id - b.id;

// Passes of pairUnits(): the very same data, then the same location, then any unit.
const PASSES = [
  (unit, row) => sameData(unit, row),
  (unit, row) => textNorm(unit.location) === textNorm(row.location),
  () => true,
];

/**
 * Pairs the rows of one code with existing units: `pairs[i]` = the unit of rows[i] (or stays
 * null). Every pass goes through the rows in file order and the candidates in their order;
 * units in `taken` are skipped and the chosen ones are added to it.
 */
function pairUnits(rows, candidates, taken, pairs) {
  if (!candidates.length) return;
  for (const fits of PASSES) {
    rows.forEach((row, i) => {
      if (pairs[i]) return;
      const unit = candidates.find((candidate) => !taken.has(candidate.id) && fits(candidate, row));
      if (!unit) return;
      taken.add(unit.id);
      pairs[i] = unit;
    });
  }
}

/**
 * Pairs every file row with an existing tool (a unit). The rows of a code take the units with
 * the same code key (same data first, then same location, then in order: active, in use,
 * oldest), so importing the same file again changes nothing and every unit keeps its loans
 * and history. A row left without a unit takes one with the same code_norm that no row of its
 * own spelling took ("UT 0012" or "UT–0012" for UT-0012): the same tool written differently
 * (`renamed`), which keeps its id, loans and history and takes the new spelling.
 * `existing` = [{ id, code, codeKey, codeNorm, location, description, active (0|1), inUse (0|1) }].
 * Returns [{ key, row, tool | null, renamed, unit, units }] in file order (`unit` = 1-based
 * position of the row among the `units` rows of its code in the file).
 */
export function matchRows(existing, groups) {
  const byKey = new Map();
  for (const tool of existing) byKey.set(tool.codeKey, [...(byKey.get(tool.codeKey) ?? []), tool]);
  for (const list of byKey.values()) list.sort(candidateOrder);
  const taken = new Set();
  const result = [];
  const pending = new Map(); // code_norm -> entries still without a unit
  for (const [key, rows] of groups) {
    const pairs = new Array(rows.length).fill(null);
    pairUnits(rows, byKey.get(key) ?? [], taken, pairs);
    rows.forEach((row, i) => {
      const entry = { key, row, tool: pairs[i], renamed: false, unit: i + 1, units: rows.length };
      if (entry.tool) {
        result.push(entry);
        return;
      }
      const norm = codeNorm(row.code);
      pending.set(norm, [...(pending.get(norm) ?? []), entry]);
    });
  }
  const byNorm = new Map();
  for (const tool of existing) {
    if (!taken.has(tool.id)) byNorm.set(tool.codeNorm, [...(byNorm.get(tool.codeNorm) ?? []), tool]);
  }
  for (const list of byNorm.values()) list.sort(candidateOrder);
  for (const [norm, entries] of pending) {
    const pairs = new Array(entries.length).fill(null);
    pairUnits(entries.map((entry) => entry.row), byNorm.get(norm) ?? [], taken, pairs);
    entries.forEach((entry, i) => result.push({ ...entry, tool: pairs[i], renamed: pairs[i] !== null }));
  }
  return result.sort((a, b) => a.row.index - b.row.index);
}

/** True when the stored tool already has the row's code, location and description. */
export const sameData = (tool, row) =>
  tool.code === row.code && tool.location === row.location && tool.description === row.description;

const fields = (x) => ({ code: x.code, location: x.location, description: x.description });

/** Adds { unit, units } to a change of a code with several units. */
const withUnit = (change, unit, units) => (units > 1 ? Object.assign(change, { unit, units }) : change);

/**
 * What a commit of `rows` would do against the `existing` tools (see matchRows), without
 * writing anything: { counts, changes (max. 500), totalChanges, multiUnit, invalid, truncated,
 * similar }. Every row is one unit: a code with several rows counts once per row.
 */
export function computeDiff(existing, rows) {
  const { groups, invalid, multiUnit, truncated, similar } = prepareRows(rows);
  const counts = {
    new: 0,
    updated: 0, // includes the renamed and reactivated ones
    renamed: 0,
    unchanged: 0,
    missing: 0,
    missingInUse: 0,
    invalid: invalid.length,
    multiUnit: multiUnit.length,
    reactivated: 0,
    truncated: truncated.length,
    similar: similar.length,
  };
  const changes = { new: [], updated: [], missing: [] };
  const matched = new Set();

  for (const { row, tool, renamed, unit, units } of matchRows(existing, groups)) {
    if (!tool) {
      counts.new++;
      changes.new.push(withUnit({ kind: 'new', code: row.code, after: fields(row) }, unit, units));
      continue;
    }
    matched.add(tool.id);
    const active = tool.active === 1;
    if (active && sameData(tool, row)) {
      counts.unchanged++;
      continue;
    }
    counts.updated++;
    if (renamed) counts.renamed++;
    const change = { kind: renamed ? 'renamed' : 'updated', code: row.code, before: { ...fields(tool), active }, after: fields(row) };
    if (!active) {
      counts.reactivated++;
      change.reactivate = true;
    }
    changes.updated.push(withUnit(change, unit, units));
  }
  // Active units of every code, by id: the unit number of a missing one.
  const activeUnits = new Map();
  for (const tool of [...existing].sort((a, b) => a.id - b.id)) {
    if (tool.active === 1) activeUnits.set(tool.codeKey, [...(activeUnits.get(tool.codeKey) ?? []), tool.id]);
  }
  for (const tool of existing) {
    if (tool.active !== 1 || matched.has(tool.id)) continue;
    counts.missing++;
    if (tool.inUse === 1) counts.missingInUse++;
    const units = activeUnits.get(tool.codeKey);
    const change = { kind: 'missing', code: tool.code, before: { ...fields(tool), active: true }, inUse: tool.inUse === 1 };
    changes.missing.push(withUnit(change, units.indexOf(tool.id) + 1, units.length));
  }
  const byCode = (a, b) => naturalCompare(a.code, b.code) || (a.unit ?? 0) - (b.unit ?? 0);
  const all = [...changes.new.sort(byCode), ...changes.updated.sort(byCode), ...changes.missing.sort(byCode)];
  return {
    counts,
    changes: all.slice(0, MAX_DIFF_CHANGES),
    totalChanges: all.length,
    multiUnit,
    invalid,
    truncated,
    similar,
  };
}
