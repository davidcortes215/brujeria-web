// Shared import logic: header synonym detection, heuristic role mapping and
// conversion of parsed rows into { code, location, description } records.

import { cleanText, textNorm } from '../normalize.js';

export const ROLES = Object.freeze(['code', 'location', 'description']);

export const IMPORT_ERROR_MESSAGES = Object.freeze({
  NO_TEXT:
    'El PDF no contiene texto seleccionable (parece escaneado o una imagen). ' +
    'Exporta el listado de nuevo como PDF con texto o como CSV.',
  INVALID_PDF: 'El archivo no es un PDF válido o está dañado.',
  ENCRYPTED_PDF: 'El PDF está protegido con contraseña. Guárdalo sin protección e inténtalo de nuevo.',
  EMPTY: 'No se ha encontrado ninguna fila de datos en el archivo.',
  TOO_MANY_ROWS: 'El archivo tiene demasiadas filas.',
  TOO_COMPLEX:
    'El archivo es demasiado complejo para leerlo. ' +
    'Exporta el listado de nuevo (PDF con texto o CSV) o divídelo en varios archivos.',
});

/** Error raised by the parsers. `code` is NO_TEXT | INVALID_PDF | EMPTY | TOO_MANY_ROWS | TOO_COMPLEX. */
export class ImportError extends Error {
  constructor(code, message = IMPORT_ERROR_MESSAGES[code] ?? 'No se ha podido leer el archivo.') {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

/** TOO_MANY_ROWS with the limit (same wording as the /diff check in sync.js). */
export const tooManyRows = (max) => new ImportError('TOO_MANY_ROWS', `El archivo tiene demasiadas filas (máximo ${max}).`);

// Header synonyms with a weight: when one header cell contains words of
// several roles, the strongest word wins ("Código útil" -> code,
// "Descripción del útil" -> description, "Nº ubicación" -> location).
const SYNONYMS = {
  code: {
    codigo: 3, cod: 3, code: 3, referencia: 2, ref: 2, herramienta: 2, utillaje: 2, util: 2, tool: 2,
    articulo: 2, matricula: 2, equipo: 2, pieza: 2, elemento: 2, identificador: 2, inventario: 2,
    'nº': 1, num: 1, numero: 1, nro: 1, id: 1,
  },
  location: {
    ubicacion: 3, ubic: 3, localizacion: 3, emplazamiento: 3, location: 3,
    situacion: 2, posicion: 2, lugar: 2, almacen: 2, estanteria: 2, sitio: 2, armario: 2, estante: 2,
    balda: 2, cajon: 2, hueco: 2, zona: 2, rack: 2, pasillo: 2,
  },
  description: {
    comentario: 3, descripcion: 3, desc: 3, observacion: 3, denominacion: 3, designacion: 3, description: 3,
    comment: 3, obs: 2, observ: 2, nota: 2, detalle: 2, note: 2, uso: 2, aplicacion: 2,
  },
};

// Words that name an identifier: followed by a location word they title the
// location column ("Código ubicación", "Nº de almacén"), not the tool code.
const IDENTIFIER_WORDS = new Set(['codigo', 'cod', 'code', 'nº', 'num', 'numero', 'nro', 'id', 'ref', 'referencia']);
const CONNECTOR_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'y', 'e', 'o', 'u', 'a', 'al', 'por', 'para', 'con', 'sin', 'su']);
// Other usual column titles: a line made only of these (and synonyms) can be part of a header.
const TITLE_WORDS = new Set([
  'fecha', 'revision', 'estado', 'cantidad', 'cant', 'unidad', 'uds', 'ud', 'marca', 'modelo', 'serie', 'tipo',
  'familia', 'subfamilia', 'grupo', 'categoria', 'seccion', 'proveedor', 'fabricante', 'responsable', 'operario',
  'usuario', 'interno', 'interna', 'actual', 'fisica', 'fisico', 'general', 'breve', 'precio', 'importe', 'medida',
  'taller', 'nave', 'planta', 'desde', 'hasta', 'disponible', 'calibracion', 'proxima', 'ultima', 'sap', 'erp',
]);
const MAX_TITLE_WORDS = 4;

function tokenizeHeader(text) {
  return textNorm(text)
    .replace(/°/g, 'º')
    .replace(/\bn\s*\.?\s*º/g, 'nº')
    .split(/[^a-z0-9º]+/)
    .filter(Boolean);
}

/** Looks a word up in a table, also as a plural ("ubicaciones", "códigos", "útiles", "notas"). */
function lookup(table, word) {
  const get = (key) => (table instanceof Set ? table.has(key) && 1 : table[key]) || 0;
  return get(word) || (word.endsWith('es') && get(word.slice(0, -2))) || (word.endsWith('s') && get(word.slice(0, -1))) || 0;
}

const synonymWeight = (role, word) => lookup(SYNONYMS[role], word);

/**
 * Classifies one header cell. Returns { role, weight } or null.
 * Cells with digits or more than 4 words are never header cells.
 */
export function classifyHeaderCell(text) {
  const words = tokenizeHeader(text);
  if (words.length === 0 || words.length > MAX_TITLE_WORDS) return null;
  if (words.some((word) => /\d/.test(word))) return null;
  let best = null;
  for (const word of words) {
    for (const role of ROLES) {
      const weight = synonymWeight(role, word);
      if (weight && (!best || weight > best.weight)) best = { role, weight };
    }
  }
  const identifier = words.findIndex((word) => IDENTIFIER_WORDS.has(word));
  if (identifier >= 0 && words.slice(identifier + 1).some((word) => synonymWeight('location', word))) {
    return { role: 'location', weight: 3 };
  }
  return best;
}

/**
 * Decides whether a row of cell texts is a header: at least 2 distinct roles,
 * at least half of the non-empty cells recognised, no digits in the other
 * cells and, unless every cell is recognised, one unmistakable title (weight 3).
 * Data rows mention header words too ("UT-0002 | Almacén | Útil de centrado").
 * Returns the per-cell classification array or null.
 */
export function detectHeader(cells) {
  const texts = cells.map((cell) => cleanText(cell));
  const nonEmpty = texts.filter(Boolean).length;
  const classes = texts.map((text) => (text ? classifyHeaderCell(text) : null));
  const matched = classes.filter(Boolean);
  if (new Set(matched.map((c) => c.role)).size < 2) return null;
  if (matched.length * 2 < nonEmpty) return null;
  const unknown = texts.filter((text, i) => text && !classes[i]);
  if (unknown.some((text) => /\d/.test(text))) return null;
  if (unknown.length && !matched.some((c) => c.weight >= 3)) return null;
  return classes;
}

/**
 * A row with a single recognised title ("Código | Sitio físico | Texto") is
 * still the header when that title is unmistakable (weight 3), no cell has
 * digits and the rows below have digits in that column (the codes).
 * `below` = the next rows' cell texts. Returns the classification or null.
 */
export function detectLooseHeader(cells, below) {
  const texts = cells.map((cell) => cleanText(cell));
  const filled = texts.filter(Boolean);
  if (filled.length < 2 || filled.some((text) => /\d/.test(text) || tokenizeHeader(text).length > MAX_TITLE_WORDS)) return null;
  const classes = texts.map((text) => (text ? classifyHeaderCell(text) : null));
  const strong = classes.findIndex((cls) => cls?.weight >= 3);
  if (strong < 0) return null;
  const values = below.map((cells) => cleanText(cells[strong])).filter(Boolean);
  if (values.length < 2 || values.filter((value) => /\d/.test(value)).length < 0.8 * values.length) return null;
  return classes;
}

/** True when `text` reads as (part of) a column title: only title words, no digits. */
export function isTitleText(text) {
  const words = tokenizeHeader(text);
  if (words.length === 0 || words.length > MAX_TITLE_WORDS) return false;
  return words.every(
    (word) =>
      !/\d/.test(word) &&
      (CONNECTOR_WORDS.has(word) || lookup(TITLE_WORDS, word) || ROLES.some((role) => synonymWeight(role, word))),
  );
}

/**
 * Two titles read as one text ("Código Ubicación": PDF generators join cells
 * closer than a wide space). Returns the index of the word where the second
 * title starts, or -1. Both parts must be titles of different roles, one of
 * them more than a bare "Nº", and the cut must not leave a connector at either side
 * ("Descripción del útil" is one title). The caller decides whether the
 * layout confirms the cut: "Código ubicación" is also a real title.
 */
export function titleSplit(text) {
  const words = cleanText(text).split(' ');
  let best = { index: -1, score: -1 };
  for (let i = 1; i < words.length; i++) {
    const left = classifyHeaderCell(words.slice(0, i).join(' '));
    const right = classifyHeaderCell(words.slice(i).join(' '));
    if (!left || !right || left.role === right.role || Math.max(left.weight, right.weight) < 2) continue;
    if (CONNECTOR_WORDS.has(tokenizeHeader(words[i])[0]) || CONNECTOR_WORDS.has(tokenizeHeader(words[i - 1]).at(-1))) continue;
    // Prefer parts that are titles of one role and a second part that starts in upper case.
    const pure = (part) =>
      new Set(
        tokenizeHeader(part)
          .filter((word) => !IDENTIFIER_WORDS.has(word))
          .flatMap((word) => ROLES.filter((role) => synonymWeight(role, word))),
      ).size <= 1;
    const score = 2 * (pure(words.slice(0, i).join(' ')) + pure(words.slice(i).join(' '))) + (/^\p{Lu}/u.test(words[i]) ? 1 : 0);
    if (score > best.score) best = { index: i, score };
  }
  return best.index;
}

// Header words of columns that never hold a description (dates, states, quantities…).
const NON_TEXT_HEADER = /\b(fecha|estado|cantidad|unidades|uds|precio|importe|revision|date|status|qty)\b/;

/**
 * Builds the role mapping from a header classification.
 * @param {({role:string, weight:number}|null)[]} classes per-column classification
 * @param {string[]} [headers] header texts (to exclude date/state columns as fallback)
 * @param {{cells:string[]}[]} [rows] data rows: several unrecognised columns fill the
 *   missing roles by their content
 */
export function mappingFromHeader(classes, headers = [], rows = null) {
  const mapping = { code: -1, location: -1, description: -1 };
  const weights = { code: 0, location: 0, description: 0 };
  classes.forEach((cls, index) => {
    if (cls && cls.weight > weights[cls.role]) {
      mapping[cls.role] = index;
      weights[cls.role] = cls.weight;
    }
  });
  // A single unrecognised column fills a single missing role ("Código | Ubicación | Uso",
  // "Artículo | Ubicación | Descripción" when a synonym is missing).
  const missing = ROLES.filter((role) => mapping[role] === -1);
  const unknown = classes
    .map((cls, index) => (cls || NON_TEXT_HEADER.test(textNorm(headers[index] ?? '')) ? -1 : index))
    .filter((index) => index >= 0);
  if (missing.length === 1 && unknown.length === 1) {
    mapping[missing[0]] = unknown[0];
  } else if (missing.length && unknown.length && rows?.length) {
    const sample = rows.slice(0, 2000);
    const stats = new Map(unknown.map((index) => [index, columnStats(sample, index)]));
    const maxAvgLen = Math.max(1, ...[...stats.values()].map((s) => s?.avgLen ?? 0));
    const free = unknown.filter((index) => stats.get(index));
    for (const role of missing) {
      if (!free.length) break;
      const score = (index) => roleScores(stats.get(index), index, maxAvgLen)[role];
      const best = free.reduce((a, b) => (score(b) > score(a) ? b : a));
      mapping[role] = best;
      free.splice(free.indexOf(best), 1);
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Heuristic mapping from content (no header).

const DATE_RE = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;

function columnStats(rows, index) {
  const values = [];
  for (const row of rows) {
    const value = cleanText(row.cells[index]);
    if (value) values.push(value);
  }
  const n = values.length;
  if (n === 0) return null;
  const frac = (predicate) => values.filter(predicate).length / n;
  const ints = values.every((v) => /^\d+$/.test(v)) ? values.map(Number) : null;
  let sequential = false;
  if (ints && n >= 3) {
    let steps = 0;
    for (let i = 1; i < n; i++) if (ints[i] === ints[i - 1] + 1) steps++;
    sequential = steps / (n - 1) >= 0.8;
  }
  return {
    fill: n / rows.length,
    uniq: new Set(values.map((v) => v.toUpperCase())).size / n,
    avgLen: values.reduce((sum, v) => sum + v.length, 0) / n,
    avgWords: values.reduce((sum, v) => sum + v.split(' ').length, 0) / n,
    digit: frac((v) => /\d/.test(v)),
    space: frac((v) => v.includes(' ')),
    mixed: frac((v) => /\d/.test(v) && /\p{L}/u.test(v)),
    date: frac((v) => DATE_RE.test(v)),
    sequential,
  };
}

function roleScores(stats, index, maxAvgLen) {
  if (!stats) return { code: -Infinity, location: -Infinity, description: -Infinity };
  const penalty = (stats.sequential ? 4 : 0) + 3 * stats.date;
  return {
    code:
      2 * stats.uniq + stats.digit + stats.mixed + (1 - stats.space) + (stats.avgLen <= 20 ? 0.5 : -1) +
      stats.fill + (index === 0 ? 0.3 : 0) - penalty,
    location:
      1.5 * (1 - stats.uniq) + (stats.avgLen <= 25 ? 1 : 0) + 0.5 * stats.digit + stats.fill -
      0.5 * Math.max(0, stats.avgWords - 3) - penalty,
    description:
      (2 * stats.avgLen) / maxAvgLen + stats.space + (stats.avgWords >= 2 ? 0.5 : 0) + 0.5 * stats.fill -
      0.3 * stats.digit - penalty,
  };
}

/** Infers { code, location, description } column indexes from the cell contents. */
export function inferMapping(rows, columnCount) {
  const sample = rows.slice(0, 2000);
  const stats = Array.from({ length: columnCount }, (_, i) => columnStats(sample, i));
  const maxAvgLen = Math.max(1, ...stats.map((s) => s?.avgLen ?? 0));
  const scores = stats.map((s, i) => roleScores(s, i, maxAvgLen));
  const usable = stats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  const mapping = { code: -1, location: -1, description: -1 };
  if (usable.length === 0) return mapping;

  let best = null;
  const consider = (code, location, description) => {
    const total =
      scores[code].code +
      (location >= 0 ? scores[location].location : 0) +
      (description >= 0 ? scores[description].description : 0);
    if (!best || total > best.total) best = { total, code, location, description };
  };
  for (const code of usable) {
    const rest = usable.filter((i) => i !== code);
    if (rest.length === 0) consider(code, -1, -1);
    if (rest.length === 1) {
      const [other] = rest;
      if (scores[other].location >= scores[other].description) consider(code, other, -1);
      else consider(code, -1, other);
    }
    for (const location of rest) {
      for (const description of rest) {
        if (location !== description && rest.length >= 2) consider(code, location, description);
      }
    }
  }
  return { code: best.code, location: best.location, description: best.description };
}

/**
 * Chooses the mapping for a parse result: header based when a header row was
 * found, heuristic otherwise. Returns { mapping, mappingSource }.
 */
export function resolveMapping(headerClasses, rows, columnCount, headers = []) {
  if (headerClasses) return { mapping: mappingFromHeader(headerClasses, headers, rows), mappingSource: 'header' };
  return { mapping: inferMapping(rows, columnCount), mappingSource: 'heuristic' };
}

/**
 * Converts parsed rows into import records using `mapping` (defaults to the
 * result's own mapping). Text is cleaned and rows without code are dropped.
 */
export function applyMapping(result, mapping = result.mapping) {
  const pick = (cells, index) => (Number.isInteger(index) && index >= 0 ? cleanText(cells[index]) : '');
  const records = [];
  for (const row of result.rows) {
    const code = pick(row.cells, mapping.code);
    if (!code) continue;
    records.push({ code, location: pick(row.cells, mapping.location), description: pick(row.cells, mapping.description) });
  }
  return records;
}
