// Text and code normalisation shared by the database layer, search, importers and tests.

// C0/C1 control characters, zero-width characters, line/paragraph separators and BOM.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\u2060\uFEFF]/g;
const COMBINING_MARKS = /[\u0300-\u036F]/g;
// Hyphens and dashes (U+2010-U+2015) and the minus sign (U+2212), common in PDFs made from Word/Excel.
const DASHES = /[\u2010-\u2015\u2212]/g;
// Everything but the Spanish ordinal indicators, which NFKC would turn into letters ("Nº" -> "NO").
const NOT_ORDINALS = /[^\u00AA\u00BA]+/g;

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Trims, collapses internal whitespace and removes control characters. */
export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Removes diacritics (NFD decomposition + combining marks). "Ubicación" -> "Ubicacion". */
export function stripDiacritics(value) {
  return String(value).normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}

/**
 * Uniqueness key of a tool code: cleaned, NFKC (full-width forms; º and ª are kept), every
 * dash as "-", upper-case, without diacritics. "ut\u20130012" (en dash) -> "UT-0012".
 */
export function codeKey(code) {
  const folded = cleanText(code).replace(NOT_ORDINALS, (part) => part.normalize('NFKC')).replace(DASHES, '-');
  return stripDiacritics(cleanText(folded).toUpperCase());
}

/** Search key of a code: only [A-Z0-9]. "ut-0012" -> "UT0012". */
export function codeNorm(value) {
  return codeKey(value).replace(/[^A-Z0-9]/g, '');
}

/**
 * Search key without zero padding: code_norm with the leading zeros of every digit run
 * of the code removed. "UT-0012" and "ut 12" -> "UT12"; "MOLDE 7-005" -> "MOLDE75".
 */
export function codeLoose(value) {
  return codeKey(value)
    .replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ''))
    .replace(/[^A-Z0-9]/g, '');
}

/** Free-text search key: lower-case, without diacritics, collapsed spaces. */
export function textNorm(value) {
  return stripDiacritics(cleanText(value).toLowerCase());
}

/** Natural order comparison ("A-2" < "A-10"), case and accent insensitive. */
export function naturalCompare(a, b) {
  return collator.compare(a ?? '', b ?? '');
}

// ---------------------------------------------------------------------------
// Kits: a tool kept inside another tool (a case or set with its own code). Pure, shared with
// the browser demo (lib/normalize.js), so both resolve Tool.container the same way.

// "INCLUIDO EN VAT 8015", "incluidas en la VAS 6131/10", "DENTRO DE T10172A", "DENTRO DEL VAS 6614A".
const CONTAINER_REF = /^(?:INCLUID[OA]S?\s+EN|DENTRO(?:\s+DEL?)?)\s+(?:(?:EL|LA|LOS|LAS)\s+)?(\S.*)$/;

/** Kits resolved inside a kit: the tool's own kit, the kit of that kit and one more. */
export const CONTAINER_MAX_DEPTH = 3;

/**
 * Code of the kit a location says the tool is in, as written (upper-case, without accents):
 * "Incluido en VAT 8015" -> "VAT 8015"; also INCLUIDA / INCLUIDOS / INCLUIDAS EN and
 * DENTRO (DE / DEL). null for any other location.
 */
export function containerRef(location) {
  const match = CONTAINER_REF.exec(stripDiacritics(cleanText(location)).toUpperCase());
  return match ? match[1] : null;
}

/**
 * The kit of a location: "INCLUIDO EN <code>" or a location that is itself a code.
 * `find(text)` -> { code, key, units: [{ id, location }] (active units, by id) } | null.
 */
function kitAt(location, find) {
  const text = cleanText(location);
  if (!text) return null;
  const kit = find(containerRef(text) ?? text);
  return kit && kit.units.length ? kit : null;
}

/** Distinct locations of a kit's units; one pointing to another kit is replaced by that kit's. */
function kitLocations(kit, find, visited, depth) {
  const locations = [];
  const seen = new Set();
  const add = (location) => {
    const text = cleanText(location);
    const key = textNorm(text);
    if (key && !seen.has(key)) {
      seen.add(key);
      locations.push(text);
    }
  };
  for (const unit of kit.units) {
    const inner = depth < CONTAINER_MAX_DEPTH ? kitAt(unit.location, find) : null;
    if (inner && !visited.has(inner.key)) {
      const nested = kitLocations(inner, find, new Set([...visited, inner.key]), depth + 1);
      if (nested.length) {
        nested.forEach(add);
        continue;
      }
    }
    add(unit.location);
  }
  return locations;
}

/**
 * Kit a tool is kept in (SPEC §4 Tool.container), or null: its location says "INCLUIDO EN
 * <code>" / "DENTRO DE <code>", or is the code of another active tool. `ownKey` is the tool's
 * code key (a tool is never its own kit); `find(text)` returns the active units of the code
 * written as `text` (by code key, else by code_norm): { code, key, units: [{ id, location }] }
 * or null. -> { code, toolId (first unit), locations } where `locations` are the distinct
 * locations of the kit's units, each resolved again when it points to another kit (at most
 * CONTAINER_MAX_DEPTH kits deep; a loop keeps the text as written).
 */
export function resolveContainer(location, ownKey, find) {
  const kit = kitAt(location, find);
  if (!kit || kit.key === ownKey) return null;
  return {
    code: kit.code,
    toolId: kit.units[0].id,
    locations: kitLocations(kit, find, new Set([ownKey, kit.key]), 1),
  };
}
