// CSV / plain text import: encoding and delimiter detection, RFC 4180 parsing.

import { cleanText } from '../normalize.js';
import { ImportError, detectHeader, detectLooseHeader, resolveMapping, tooManyRows } from './columns.js';

export { ImportError };

const DELIMITERS = [';', '\t', ','];
const HEADER_SEARCH_ROWS = 10;
// Longer cells cannot be imported anyway (field limits are far lower); they are cut to keep the result small.
const MAX_CELL_CHARS = 5000;
// Any character that cleanText keeps.
const CONTENT_CHAR = /[^\s\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2060]/;

/** Decodes bytes: UTF-8 (with or without BOM), UTF-16 with BOM, otherwise windows-1252. */
export function decodeText(input) {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Number of line breaks (CRLF, LF or CR) in text[from, to). */
function countBreaks(text, from, to) {
  let count = 0;
  for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) count++;
  for (let i = text.indexOf('\r', from); i >= 0 && i < to; i = text.indexOf('\r', i + 1)) {
    if (text[i + 1] !== '\n') count++;
  }
  return count;
}

/**
 * RFC 4180 parser: quoted fields, doubled quotes, delimiters and line breaks
 * inside quotes, CRLF / LF / CR line endings. Returns { records, lines,
 * truncated, unterminated } where lines[i] is the 1-based line number where
 * record i starts, `truncated` tells that parsing stopped after `maxRecords`
 * non-blank records and `unterminated` is the line of a quote that is never
 * closed (null when there is none). Fields are sliced from the text, not
 * built character by character, so large files parse in linear time.
 */
export function parseDelimited(text, delimiter, maxRecords = Infinity) {
  const records = [];
  const lines = [];
  const fieldEnd = new RegExp(`[${delimiter.replace(/[\\\]^-]/g, '\\$&')}\\r\\n]`, 'g');
  const n = text.length;
  let record = [];
  let line = 1;
  let recordLine = 1;
  let filled = 0;
  let truncated = false;
  let unterminated = null;
  let i = 0;
  const endRecord = () => {
    records.push(record);
    lines.push(recordLine);
    if (!isBlank(record)) filled++;
    record = [];
  };
  while (i < n) {
    // A quote opens a quoted field only after optional leading spaces.
    let k = i;
    while (k < n && (text[k] === ' ' || text[k] === '\t') && text[k] !== delimiter) k++;
    let field = '';
    let from = i;
    let open = false;
    if (text[k] === '"') {
      let p = k + 1;
      for (;;) {
        const q = text.indexOf('"', p);
        if (q < 0) {
          open = true;
          unterminated ??= line;
          line += countBreaks(text, p, n);
          field += text.slice(p);
          p = n;
          break;
        }
        line += countBreaks(text, p, q);
        field += text.slice(p, q);
        if (text[q + 1] !== '"') {
          p = q + 1;
          break;
        }
        field += '"';
        p = q + 2;
      }
      from = p; // text after the closing quote is kept (quotes there are literal)
    }
    fieldEnd.lastIndex = from;
    const end = fieldEnd.exec(text)?.index ?? n;
    field += text.slice(from, end);
    i = end;
    // An empty quoted field alone after the last line break is not a record.
    if (i >= n && !record.length && !field && !open) break;
    record.push(field);
    if (i >= n) break;
    if (text[i] === delimiter) {
      i++;
      if (i === n) record.push(''); // "a;b;" ends with an empty field
      continue;
    }
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    endRecord();
    line++;
    recordLine = line;
    if (filled > maxRecords) {
      truncated = i < n;
      break;
    }
  }
  if (record.length) endRecord();
  return { records, lines, truncated, unterminated };
}

const isBlank = (record) => record.every((cell) => cleanText(cell) === '');

/** Picks the delimiter that splits the first lines most consistently into 2+ fields. */
export function detectDelimiter(text) {
  const sample = text.slice(0, 64 * 1024);
  let best = { delimiter: ';', score: 0 };
  for (const delimiter of DELIMITERS) {
    const records = parseDelimited(sample, delimiter).records.filter((r) => !isBlank(r)).slice(0, 30);
    if (records.length === 0) continue;
    const counts = new Map();
    for (const record of records) counts.set(record.length, (counts.get(record.length) ?? 0) + 1);
    let modeCount = 1;
    let modeFreq = 0;
    for (const [count, freq] of counts) {
      if (freq > modeFreq || (freq === modeFreq && count > modeCount)) {
        modeCount = count;
        modeFreq = freq;
      }
    }
    if (modeCount < 2) continue;
    const consistency = modeFreq / records.length;
    // Consistency first; more columns breaks ties; DELIMITERS order breaks exact ties.
    const score = consistency * 100 + Math.min(modeCount, 20) / 100;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

// export.csv writes "'=…", "'+…", "'-…" and "'@…" so that spreadsheets do not run
// them as formulas; importing that file again restores the original text.
const unescapeFormula = (cell) => (/^'[=+\-@]/.test(cell) ? cell.slice(1) : cell);

const filledIn = (cells, columns) => columns.filter((index) => cells[index]).length;

/**
 * Header row: the first row matching the synonyms among the first rows (rows
 * above it are titles). A candidate with 2+ data-like rows above it (filled in
 * its columns) is a data row that mentions header words. Without a header, a
 * first row with one unmistakable title and codes below it still counts.
 * Returns { index, classes } or null.
 */
function findHeaderRow(all) {
  const limit = Math.min(all.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < limit; i++) {
    const classes = detectHeader(all[i].cells);
    if (!classes) continue;
    const titled = classes.map((cls, index) => (cls ? index : -1)).filter((index) => index >= 0);
    const dataAbove = all.slice(0, i).filter((row) => filledIn(row.cells, titled) >= 2).length;
    if (dataAbove < 2) return { index: i, classes };
  }
  // Rows above a loose header can only be titles (one filled cell).
  for (let i = 0; i < limit; i++) {
    const { cells } = all[i];
    if (cells.filter(Boolean).length < 2) continue;
    const below = all.slice(i + 1, i + 21).map((row) => row.cells);
    const classes = detectLooseHeader(cells, below);
    return classes ? { index: i, classes } : null;
  }
  return null;
}

/**
 * Parses a CSV/TXT buffer into the common parse result shape (source 'csv').
 * `maxRows` stops parsing early with TOO_MANY_ROWS.
 */
export function parseCsv(input, { maxRows = Infinity } = {}) {
  let text = decodeText(input);
  const warnings = [];

  // Excel "sep=;" hint on the first line.
  let forcedDelimiter = null;
  const sepHint = /^sep=(.)\r?\n/i.exec(text);
  if (sepHint) {
    forcedDelimiter = sepHint[1];
    text = text.slice(sepHint[0].length);
  }
  if (!CONTENT_CHAR.test(text)) throw new ImportError('EMPTY');

  const delimiter = forcedDelimiter ?? detectDelimiter(text);
  // Header and title rows come on top of the data rows.
  const parsed = parseDelimited(text, delimiter, maxRows + HEADER_SEARCH_ROWS);
  if (parsed.truncated) throw tooManyRows(maxRows);
  const all = [];
  const lineOffset = sepHint ? 1 : 0;
  parsed.records.forEach((record, i) => {
    if (isBlank(record)) return;
    const cells = record.map((cell) => unescapeFormula(cleanText(cell.length > MAX_CELL_CHARS ? cell.slice(0, MAX_CELL_CHARS) : cell)));
    all.push({ cells, line: parsed.lines[i] + lineOffset });
  });
  if (all.length === 0) throw new ImportError('EMPTY');
  if (parsed.unterminated !== null) {
    warnings.push({
      type: 'skipped_line',
      message: `Hay unas comillas sin cerrar en la línea ${parsed.unterminated + lineOffset}: el resto del archivo se ha leído como un solo texto.`,
      page: null,
      line: parsed.unterminated + lineOffset,
    });
  }

  const header = findHeaderRow(all);
  const headerIndex = header?.index ?? -1;
  for (let i = 0; i < headerIndex; i++) {
    const text = all[i].cells.filter(Boolean).join(' ');
    warnings.push({ type: 'skipped_line', message: `Línea omitida (encima de la cabecera): «${text}»`, page: null, line: all[i].line });
  }
  const headerRow = header ? all[headerIndex] : null;
  const dataRows = all.slice(headerIndex + 1);
  if (dataRows.length > maxRows) throw tooManyRows(maxRows);

  // Drop trailing empty columns (e.g. "a;b;c;;;" from spreadsheets).
  const columnCount = dataRows.reduce(
    (max, r) => Math.max(max, lastFilled(r.cells) + 1),
    Math.max(1, headerRow ? lastFilled(headerRow.cells) + 1 : 0),
  );
  const pad = (cells) => Array.from({ length: columnCount }, (_, i) => cells[i] ?? '');
  const rows = dataRows.map((r) => ({ cells: pad(r.cells), page: null, line: r.line }));
  if (rows.length === 0) throw new ImportError('EMPTY');

  if (!headerRow) {
    warnings.unshift({
      type: 'no_header',
      message: 'No se ha encontrado una fila de cabecera; las columnas se han asignado por su contenido.',
      page: null,
    });
  }
  const headers = headerRow ? pad(headerRow.cells) : null;
  const classes = headerRow ? Array.from({ length: columnCount }, (_, i) => header.classes[i] ?? null) : null;
  const { mapping, mappingSource } = resolveMapping(classes, rows, columnCount, headers ?? []);

  return { source: 'csv', pages: null, columnCount, headers, mapping, mappingSource, rows, warnings, delimiter };
}

function lastFilled(cells) {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i]) return i;
  return -1;
}
