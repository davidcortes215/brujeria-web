// Zones of a pick-up walk: a location is split into its zone (where the operator walks to)
// and its slot (where exactly, once there), so the tools to take can be grouped by zone and
// each zone is walked once. Pure module (no DOM): the Node tests import it too.
//
// Workshop formats, in this order (zoneOf):
//   kit        the tool is inside another tool (Tool.container, "INCLUIDO EN VAT 8015"):
//              zone of the kit's first location, slot "en VAT 8015"
//   places     "FA-5-4/ AR2C2", "PANEL 3B Y BF-2-6": the first place, when it is one of these:
//   cabinet    armario / mueble + cajón: "AR2C4", "AR2 C4", "M4C2", "M3E1" -> AR2 + C4; "AR3" alone
//   row        fila de estantería - módulo - balda: "FB-1-3", "FB 1-3", "BF0-7" -> FB + 1-3
//   panel      "PANEL 2B", "PANEL 1 BANDEJA BAJA", "PANEL 5" -> PANEL 2 + B
//   on top     "ENCIMA AR2", "ENCIMA ARMARIO ELECTRICIDAD": the zone below, slot "ENCIMA"
//   area      other catalogues, split at separators: "Metrología AM-1 / B4", "Carro 4 - Cajón 1"
//   place      anything else is a zone by itself: TALLER, CHAPA, PEDIR, "NO EXISTE GET"
//   none       no location ("Sin ubicación")

import { cleanText, naturalCompare, textNorm } from './normalize.js';

export const NO_LOCATION_ZONE = 'Sin ubicación';

/** Kinds of zone returned by zoneOf(). */
export const ZONE_KINDS = Object.freeze(['cabinet', 'row', 'panel', 'area', 'place', 'none']);

// Armario / mueble (1-4 letters + number) and cajón (1-2 letters + number): "AR2C4", "AR2 C4",
// "AR2-C2", "M4C2", "M3E1". A cabinet alone has no space inside ("AR3", "M4").
const CABINET = /^([A-Z]{1,4}\s?\d+)[\s-]*([A-Z]{1,2}\s?\d+[A-Z]?)$/i;
const CABINET_ALONE = /^[A-Z]{1,4}\d+$/i;
const DRAWER_ALONE = /^[A-Z]{1,2}\s?\d+[A-Z]?$/i;
// Fila (1-3 letters), módulo and balda: "FB-1-3", "FB 1-3", "BF0-7", "FA- 6-5", "BE -2-1".
const ROW = /^([A-Z]{1,3})[\s-]*(\d+)\s*-\s*(\d+)$/i;
// "PANEL 2B", "PANEL 1 BANDEJA BAJA", "PANEL 5".
const PANEL = /^PANEL\s*(\d+)\s*(.*)$/i;
// Several places for one tool: "FA-5-4/ AR2C2", "PANEL 3B Y BF-2-6".
const PLACES = /\s*\/\s*|\s+Y\s+/i;
// On top of a place: "ENCIMA AR2" -> zone AR2, slot "ENCIMA".
const ON_TOP = /^(ENCIMA)\s+(?:(?:DE|DEL)\s+)?(\S.*)$/i;

// Separators of the "area" rule: "/", "|" and "," with or without spaces around; a dash
// (hyphen, en/em dash, minus) or a middle dot only between spaces, so the hyphen of "AM-1" or
// "ARM-05" is not a separator. The capture group keeps the separators in the result of split().
const SEPARATOR = /(\s*[/|,]\s*|\s[\-\u2010-\u2015\u2212\u00b7\u2022]\s)/;
// A "/" between digits or between single letters is part of the text, not a separator:
// dates ("PEDIDO 157685 30/11/2021"), kit numbers ("VAS 6131/10"), "MAQUINA A/C".
const KEPT_SLASH = /(\d)\/(?=\d)|(\b[A-Z])\/(?=[A-Z]\b)/gi;
const SLASH_MARK = '\u0000'; // never in a cleaned text (cleanText removes control characters)
// Zone keys ignore these separators and the spaces between letters and digits ("AR 2" = "AR2").
const KEY_SEPARATORS = /[\s\-\u2010-\u2015\u2212\u00b7\u2022/|,]+/g;

const compact = (text) => text.replace(/\s+/g, '').toUpperCase();

/** Zone key: case, accents, separators and letter-digit spaces ignored. */
function keyOf(zone) {
  return textNorm(zone)
    .replace(KEY_SEPARATORS, ' ')
    .trim()
    .replace(/([a-z]) (?=\d)|(\d) (?=[a-z])/g, '$1$2');
}

/** Cabinet, row or panel of a single place, or null. */
function structured(place) {
  let match = ROW.exec(place);
  if (match) {
    return { zone: match[1].toUpperCase(), slot: `${Number(match[2])}-${Number(match[3])}`, kind: 'row' };
  }
  match = CABINET.exec(place);
  if (match) return { zone: compact(match[1]), slot: compact(match[2]), kind: 'cabinet' };
  if (CABINET_ALONE.test(place)) return { zone: place.toUpperCase(), slot: '', kind: 'cabinet' };
  match = PANEL.exec(place);
  if (match) return { zone: `PANEL ${Number(match[1])}`, slot: match[2].trim(), kind: 'panel' };
  return null;
}

/** "FA-5-4/ AR2C2": the first place, when it is a cabinet, row or panel (see the header). */
function firstPlace(text) {
  const places = text
    .split(PLACES)
    .map((place) => place.trim())
    .filter(Boolean);
  if (places.length < 2) return null;
  const first = structured(places[0]);
  if (!first) return null;
  // "AR2/C4": a cabinet and then its drawer.
  if (first.kind === 'cabinet' && !first.slot && DRAWER_ALONE.test(places[1])) {
    return { ...first, slot: compact(places[1]) };
  }
  return first.slot || structured(places[1]) ? first : null;
}

/** Non-empty segments of a cleaned location, each with the separator written before it. */
function segmentsOf(text) {
  const parts = text
    .replace(KEPT_SLASH, `$1$2${SLASH_MARK}`)
    .split(SEPARATOR) // [segment, separator, segment, ...]
    .map((part) => part.replaceAll(SLASH_MARK, '/'));
  const segments = [];
  let separator = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) {
      if (!separator) separator = parts[i];
      continue;
    }
    const segment = parts[i].trim();
    if (!segment) continue;
    segments.push({ segment, separator: segments.length ? separator : '' });
    separator = '';
  }
  return segments;
}

/** { zone, slot, kind, key } of a location without kit. */
function parseLocation(location) {
  const text = cleanText(location);
  if (!text) return { zone: NO_LOCATION_ZONE, slot: '', kind: 'none', key: '' };
  const found = firstPlace(text) ?? structured(text);
  if (found) return { ...found, key: keyOf(found.zone) };
  // "ENCIMA AR2", "ENCIMA ARMARIO ELECTRICIDAD": on top of a place is in its zone.
  const onTop = ON_TOP.exec(text);
  if (onTop) {
    const below = parseLocation(onTop[2]);
    if (below.kind !== 'none') return { ...below, slot: below.slot ? `${onTop[1]} ${below.slot}` : onTop[1] };
  }
  const segments = segmentsOf(text);
  // A single segment is a zone by itself ("TALLER", "Banco 3"); only separators ("/"): the text as is.
  if (segments.length < 2) {
    const zone = segments[0]?.segment ?? text;
    return { zone, slot: '', kind: 'place', key: keyOf(zone) };
  }
  const slot = segments.pop().segment;
  const zone = segments.map((s) => s.separator + s.segment).join('');
  return { zone, slot, kind: 'area', key: keyOf(zone) };
}

/** Code and first non-empty location of a Tool.container ({ code, locations }), or null. */
function kitOf(container) {
  if (!container || typeof container !== 'object') return null;
  const code = cleanText(container.code);
  const locations = Array.isArray(container.locations) ? container.locations : [];
  const location = locations.map(cleanText).find(Boolean);
  return code && location ? { code, location } : null;
}

/** zoneOf() plus the zone key (groupByZone). */
function parse(location, container) {
  const kit = kitOf(container);
  if (!kit) return parseLocation(location);
  const at = parseLocation(kit.location);
  return { ...at, slot: `en ${kit.code}`, container: kit.code, kitSlot: at.slot };
}

/**
 * Zone, slot and kind of a location (see the formats in the header): "AR2C4" ->
 * { zone: "AR2", slot: "C4", kind: "cabinet" }; "FB 1-3" -> { zone: "FB", slot: "1-3",
 * kind: "row" }; "PANEL 2B" -> { zone: "PANEL 2", slot: "B", kind: "panel" };
 * "Carro 4 - Cajón 1" -> { zone: "Carro 4", slot: "Cajón 1", kind: "area" }; "TALLER" ->
 * { zone: "TALLER", slot: "", kind: "place" }; empty -> { zone: "Sin ubicación", slot: "",
 * kind: "none" }. With `options.container` (Tool.container, { code, locations }) the zone is the
 * one of the kit's first location: "INCLUIDO EN VAT 8015" with the kit in "AR1C3" ->
 * { zone: "AR1", slot: "en VAT 8015", kind: "cabinet", container: "VAT 8015", kitSlot: "C3" }.
 */
export function zoneOf(location, { container = null } = {}) {
  const { key, ...info } = parse(location, container);
  return info;
}

/**
 * Name of a zone for people: "Armario AR2" (cabinets AR<n>; other cabinets by their code:
 * "M4"), "Fila FB", "PANEL 2"; any other zone as written.
 */
export function zoneLabel(zone, kind) {
  if (kind === 'none' || !cleanText(zone)) return NO_LOCATION_ZONE;
  if (kind === 'cabinet' && /^AR\d/i.test(zone)) return `Armario ${zone}`;
  if (kind === 'row') return `Fila ${zone}`;
  return zone;
}

// Between the parts of a slot label (middle dot).
const MIDDLE_DOT = ' \u00b7 ';

/** Slot for people: cabinet "C4" -> "Cajón 4"; row "1-3" -> "Módulo 1 · Balda 3"; others as written. */
export function slotLabel(slot, kind) {
  const text = cleanText(slot);
  if (kind === 'cabinet') {
    const drawer = /^C\s?(\d+[A-Z]?)$/i.exec(text);
    if (drawer) return `Cajón ${drawer[1].toUpperCase()}`;
  }
  if (kind === 'row') {
    const row = /^(\d+)-(\d+)$/.exec(text);
    if (row) return `Módulo ${row[1]}${MIDDLE_DOT}Balda ${row[2]}`;
  }
  return text;
}

/** Slot of an entry for people, kit included: "Cajón 3 · en VAT 8015". */
function entryLabel(entry) {
  if (!entry.container) return slotLabel(entry.slot, entry.kind);
  const base = slotLabel(entry.kitSlot, entry.kind);
  return base ? `${base}${MIDDLE_DOT}${entry.slot}` : entry.slot;
}

// Inside a zone: slot (a kit's contents next to the kit's own slot), then location, code,
// unit number and id.
const compareEntries = (a, b) =>
  naturalCompare(a.kitSlot ?? a.slot, b.kitSlot ?? b.slot) ||
  naturalCompare(a.slot, b.slot) ||
  naturalCompare(a.tool.location, b.tool.location) ||
  naturalCompare(a.tool.code, b.tool.code) ||
  (a.tool.unitIndex ?? 0) - (b.tool.unitIndex ?? 0) ||
  (a.tool.id ?? 0) - (b.tool.id ?? 0);

/**
 * Groups tools by zone (each tool's `container` included): [{ zone, key, kind, label, tools,
 * entries }], zones in natural order ("Sin ubicación" last); tools of a zone by slot, location,
 * code and unit. Zones that only differ in case, accents or separators are one group, shown as
 * written in its first tool. `entries[i]` describes `tools[i]`: { tool, slot, kind, container,
 * kitSlot, slotLabel } (slotLabel: "Cajón 4", "Módulo 1 · Balda 3", "en VAT 8015").
 * The input array is not modified.
 */
export function groupByZone(tools) {
  const entries = tools.map((tool) => ({ tool, ...parse(tool.location, tool.container) })).sort(compareEntries);
  const groups = new Map();
  for (const entry of entries) {
    const { tool, zone, key, kind } = entry;
    if (!groups.has(key)) groups.set(key, { zone, key, kind, label: zoneLabel(zone, kind), tools: [], entries: [] });
    const group = groups.get(key);
    group.tools.push(tool);
    group.entries.push({
      tool,
      slot: entry.slot,
      kind,
      container: entry.container ?? null,
      kitSlot: entry.kitSlot ?? null,
      slotLabel: entryLabel(entry),
    });
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    return naturalCompare(a.zone, b.zone) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}
