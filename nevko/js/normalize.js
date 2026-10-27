// Text and code normalisation. Mirrors server/normalize.js so that the client
// ranks and highlights exactly what the server matched.

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\u2060\uFEFF]/g;
const COMBINING_MARKS = /[\u0300-\u036F]/g;
// Hyphens and dashes (U+2010-U+2015) and the minus sign (U+2212).
const DASHES = /[\u2010-\u2015\u2212]/g;
// Everything but the Spanish ordinal indicators, which NFKC would turn into letters ("Nº" -> "NO").
const NOT_ORDINALS = /[^\u00AA\u00BA]+/g;

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Trims, collapses internal whitespace and removes control characters. */
export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Removes diacritics: "Ubicación" -> "Ubicacion". */
export function stripDiacritics(value) {
  return String(value).normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}

/** Uniqueness key of a tool code: cleaned, NFKC (º and ª kept), every dash as "-", upper-case, without diacritics. */
export function codeKey(code) {
  const folded = cleanText(code).replace(NOT_ORDINALS, (part) => part.normalize('NFKC')).replace(DASHES, '-');
  return stripDiacritics(cleanText(folded).toUpperCase());
}

/** Search key of a code: only [A-Z0-9]. "ut-0012" -> "UT0012". */
export function codeNorm(value) {
  return codeKey(value).replace(/[^A-Z0-9]/g, '');
}

/** Search key without zero padding (leading zeros of every digit run): "UT-0012" and "ut 12" -> "UT12". */
export function codeLoose(value) {
  return codeKey(value)
    .replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ''))
    .replace(/[^A-Z0-9]/g, '');
}

/** True when a query has no zero padding ("ut 12", not "ut 0012"): the server also compares it with codeLoose. */
export function matchesLoose(query) {
  const norm = codeNorm(query);
  return Boolean(norm) && codeLoose(query) === norm;
}

/** Free-text search key: lower-case, without diacritics, collapsed spaces. */
export function textNorm(value) {
  return stripDiacritics(cleanText(value).toLowerCase());
}

/** Natural order comparison ("A-2" < "A-10"), case and accent insensitive. */
export function naturalCompare(a, b) {
  return collator.compare(a ?? '', b ?? '');
}
