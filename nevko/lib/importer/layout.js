// PDF layout analysis: turns the text pieces of a tabular PDF into rows of cells (SPEC §5).
// Pure JavaScript without Node.js or pdf.js imports: the server (importer/pdf.js, through
// pdf-document.js) and the browser demo share it.
//
// Pipeline per document (extraction itself lives in pdf-document.js):
//   1. text pieces (upright text only, whitespace items ignored; strings with
//      runs of 2+ spaces are split with proportional character widths)
//   2. group pieces into lines by baseline (tolerance 40 % of the font height)
//   3. find the header: one line, or a band of lines when titles wrap; titles
//      that the PDF joined ("Código Ubicación") are split where the data
//      columns start. Titles above it and repeated headers are skipped
//   4. drop page furniture (page numbers, dates, URLs, lines repeated on many
//      pages, text in the page margins), but never inside the table body
//   5. derive column boundaries from the header (data aligned with the titles,
//      aligned edges before centred titles, or the empty gutter between
//      columns) or, without header, by clustering the left edges of the cells
//   6. assign every piece to a column, splitting pieces that cross a boundary;
//      notes and signatures under the table are skipped
//   7. attach continuation lines (empty code cell) to the row above or below:
//      the vertical alignment of the cells is learned from the document

import { cleanText, textNorm } from '../normalize.js';
import {
  ImportError,
  classifyHeaderCell,
  detectHeader,
  detectLooseHeader,
  inferMapping,
  isTitleText,
  mappingFromHeader,
  titleSplit,
  tooManyRows,
} from './columns.js';

const LINE_TOLERANCE = 0.4; // × font height: pieces closer than this share a line
const SEGMENT_GAP = 0.8; // × font height: pieces closer than this form one cell-like segment
const HEADER_PIECE_GAP = 0.35; // × font height: tighter merge used to split crowded header lines
const WORD_GAP = 0.15; // × font height: gaps above this become a space when joining text
const ALIGN_TOLERANCE = 0.5; // × font height: left edges within this belong to the same column
const BAND_GAP = 1.6; // × font height: lines of one header row (wrapped titles) are closer than this
const CONTINUATION_GAP = 1.7; // × font height: wrapped lines of one cell are closer than this
const PAGE_MARGIN = 0.08; // share of the page height (top and bottom) where running headers and footers live
const MAX_WARNINGS = 100;
const HEADER_SEARCH_LINES = 8; // a repeated header is expected among the first lines of a page

const FOOTER_PATTERNS = [
  /^(pag(ina)?\.?\s*)?\d+\s*(de|\/|of)\s*\d+$/, // "Página 3 de 5", "3/5", "3 de 5"
  /^pag(ina)?\.?\s*\d+$/, // "Pág. 3"
  /^[-–—]\s*\d+\s*[-–—]$/, // "- 3 -"
  /^\d{1,4}$/, // lone page number
  /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(,?\s+\d{1,2}:\d{2}(:\d{2})?)?$/, // 25/09/2026 [08:14]
  /^\d{4}-\d{2}-\d{2}([ t]\d{1,2}:\d{2}(:\d{2})?)?$/, // 2026-09-25
  /^(\p{L}+,?\s+)?\d{1,2}\s+de\s+\p{L}+\s+de\s+\d{4}$/u, // "25 de septiembre de 2026"
  /^(https?|file):\/\/\S+$/, // browser print footer: page address
];
const PAGE_MARK = /\bpag(\.|ina)?\s*\d+(\s*(de|\/)\s*\d+)?\b/;
const SUMMARY_LINE = /^(total|subtotal|suma|firma|fecha|impreso|generado|p[aá]gina|revisado|aprobado|elaborado|firmado|notas?)(?=[\s:.]|$)/i;

// ---------------------------------------------------------------------------
// 1. Pieces

let pieceSeq = 0;

/** Splits a text item into pieces at runs of 2+ spaces (or tabs), trimming edge spaces. */
export function splitItem(item) {
  const { str } = item;
  const charW = item.w / Math.max(1, str.length);
  const src = ++pieceSeq;
  const pieces = [];
  const re = /[^\s]+(?:[  ][^\s]+)*/g;
  let match;
  while ((match = re.exec(str))) {
    pieces.push({
      x: item.x + match.index * charW,
      w: match[0].length * charW,
      y: item.y,
      h: item.h,
      str: match[0],
      src,
    });
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// 2. Lines and segments

export function groupLines(pieces) {
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const piece of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(piece.y - line.y) <= LINE_TOLERANCE * Math.max(piece.h, line.h)) {
      line.pieces.push(piece);
      line.h = Math.max(line.h, piece.h);
    } else {
      lines.push({ y: piece.y, h: piece.h, pieces: [piece] });
    }
  }
  for (const line of lines) {
    line.pieces.sort((a, b) => a.x - b.x);
    // Some generators fake bold text by drawing the same string twice with a tiny offset.
    line.pieces = line.pieces.filter(
      (piece, i, all) => !all.slice(Math.max(0, i - 3), i).some((other) => other.str === piece.str && Math.abs(other.x - piece.x) < 0.3 * piece.h),
    );
    line.segments = mergePieces(line.pieces, SEGMENT_GAP);
    line.text = line.segments.map((s) => s.text).join(' ');
    line.norm = textNorm(line.text);
  }
  return lines;
}

function joinPieces(pieces) {
  let text = '';
  let prev = null;
  for (const piece of pieces) {
    if (prev) {
      const gap = piece.x - (prev.x + prev.w);
      if (gap > WORD_GAP * Math.max(piece.h, prev.h)) text += ' ';
    }
    text += piece.str;
    prev = piece;
  }
  return cleanText(text);
}

/** Merges neighbouring pieces separated by less than gapFactor × font height. */
function mergePieces(pieces, gapFactor) {
  const segments = [];
  let current = null;
  for (const piece of pieces) {
    const gap = current ? piece.x - current.end : Infinity;
    // Pieces split from the same string at 2+ spaces are separate cells on purpose;
    // a piece starting well inside the previous one overlaps it (a clipped title).
    const sameSource = current && current.pieces.at(-1).src === piece.src;
    const h = Math.max(piece.h, current?.h ?? 0);
    if (current && !sameSource && gap < gapFactor * h && gap > -0.1 * h) {
      current.pieces.push(piece);
      current.end = Math.max(current.end, piece.x + piece.w);
      current.h = Math.max(current.h, piece.h);
    } else {
      current = { x: piece.x, end: piece.x + piece.w, h: piece.h, pieces: [piece] };
      segments.push(current);
    }
  }
  for (const segment of segments) segment.text = joinPieces(segment.pieces);
  return segments;
}

/** Words of a run of pieces with their estimated left edge (proportional widths). */
function wordsOf(pieces) {
  const words = [];
  let prev = null;
  for (const piece of pieces) {
    const charW = piece.w / Math.max(1, piece.str.length);
    const glued = prev && piece.x - (prev.x + prev.w) <= WORD_GAP * Math.max(piece.h, prev.h);
    for (const match of piece.str.matchAll(/\S+/g)) {
      if (glued && match.index === 0 && words.length) words.at(-1).text += match[0];
      else words.push({ text: match[0], x: piece.x + match.index * charW });
    }
    prev = piece;
  }
  return words;
}

const medianOf = (values, fallback) => {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const medianHeight = (lines) => medianOf(lines.map((l) => l.h), 10);

// ---------------------------------------------------------------------------
// 3. Header

const isFooterPart = (norm) => FOOTER_PATTERNS.some((re) => re.test(norm));

const isTitleLine = (line) => !/\d/.test(line.text) && line.segments.every((segment) => isTitleText(segment.text));

const withClasses = (cells, classes) => cells.map((cell, i) => ({ ...cell, cls: classes[i] }));

/** Header cells of a single line, or null. Page marks printed on the header line are ignored. */
function headerOfLine(line) {
  const usable = (segments) => segments.filter((segment) => !isFooterPart(textNorm(segment.text)));
  let cells = usable(line.segments);
  let classes = detectHeader(cells.map((s) => s.text));
  if (!classes) {
    // Crowded header rows may have merged two titles into one segment.
    const tighter = usable(mergePieces(line.pieces, HEADER_PIECE_GAP));
    if (tighter.length > cells.length) {
      classes = detectHeader(tighter.map((s) => s.text));
      cells = tighter;
    }
  }
  if (!classes) return null;
  return withClasses(
    cells.map((cell) => ({ x: cell.x, end: cell.end, h: cell.h, text: cell.text, pieces: cell.pieces })),
    classes,
  );
}

/**
 * Cells of a header band (titles wrapped on several lines): the segments of
 * all lines merged by horizontal overlap, text top to bottom. Null when one
 * segment overlaps several titles (a group title above sub-columns).
 */
function bandCells(lines) {
  const cells = [];
  lines.forEach((line, index) => {
    const own = []; // cells of this line: titles side by side never merge
    for (const segment of line.segments) {
      if (isFooterPart(textNorm(segment.text))) continue;
      const pad = 0.3 * segment.h;
      const hits = cells.filter((cell) => !own.includes(cell) && segment.x < cell.end + pad && segment.end > cell.x - pad);
      if (hits.length > 1) return (cells.length = 0);
      const [cell] = hits;
      if (cell) {
        cell.x = Math.min(cell.x, segment.x);
        cell.end = Math.max(cell.end, segment.end);
        cell.text = `${cell.text} ${segment.text}`;
        cell.pieces.push(...segment.pieces);
        own.push(cell);
      } else {
        own.push({ x: segment.x, end: segment.end, h: segment.h, text: segment.text, pieces: [...segment.pieces], line: index });
        cells.push(own.at(-1));
      }
    }
  });
  return cells.length ? cells.sort((a, b) => a.x - b.x) : null;
}

/**
 * Header starting at line i: the line itself when it is a header, extended
 * with neighbouring lines made only of title words ("Código" / "útil").
 * Returns { start, end, cells } (line indexes) or null.
 */
function headerBand(lines, i) {
  const single = headerOfLine(lines[i]);
  if (!single && !isTitleLine(lines[i])) return null;
  const near = (a, b) => b.y - a.y <= BAND_GAP * Math.max(a.h, b.h);
  // A title-like line that goes on in the line below it, at the same left edge
  // and no further away, is the first line of a wrapped data cell ("Armario" /
  // "metálico 3" under a bottom-aligned header), not part of the header.
  const startsCell = (j) => {
    const below = lines[j + 1];
    return (
      below && !isTitleLine(below) && below.y - lines[j].y <= lines[j].y - lines[j - 1].y + 0.1 &&
      below.pieces.some((p) => lines[j].pieces.some((q) => Math.abs(p.x - q.x) <= 0.5))
    );
  };
  let start = i;
  let end = i;
  while (end + 1 < lines.length && isTitleLine(lines[end + 1]) && near(lines[end], lines[end + 1]) && !startsCell(end + 1)) end++;
  if (single) while (start > 0 && isTitleLine(lines[start - 1]) && near(lines[start - 1], lines[start])) start--;
  if (end > start) {
    const cells = bandCells(lines.slice(start, end + 1));
    const classes = cells && detectHeader(cells.map((cell) => cell.text));
    if (classes) return { start, end, cells: withClasses(cells, classes) };
  }
  return single ? { start: i, end: i, cells: single } : null;
}

/** Lines above a header candidate that already look like rows of its table. */
function tableRowsAbove(lines, band) {
  let count = 0;
  for (const line of lines.slice(0, band.start)) {
    const tolerance = Math.max(line.h, 4);
    const aligned = line.segments.filter((segment) => band.cells.some((cell) => Math.abs(segment.x - cell.x) <= tolerance));
    if (aligned.length >= 2) count++;
  }
  return count;
}

/**
 * Text pieces of a line as { x, end } spans. Column geometry uses pieces, not
 * segments: cells closer than a segment gap are still separate pieces.
 */
const spansOf = (line) => line.pieces.map((piece) => ({ x: piece.x, end: piece.x + piece.w }));

/**
 * Left edges of the lines' pieces that start together within `tolerance` of
 * x (one per line). Left-aligned cells share the very same edge; centred cells
 * that merely happen to start near x do not count.
 */
function startsNear(lines, x, tolerance) {
  const hits = [];
  for (const line of lines) {
    const piece = line.pieces.find((p) => Math.abs(p.x - x) <= tolerance);
    if (piece) hits.push({ x: piece.x, h: piece.h });
  }
  const middle = medianOf(hits.map((hit) => hit.x), x);
  return hits.filter((hit) => Math.abs(hit.x - middle) <= Math.max(0.5, 0.1 * hit.h)).map((hit) => hit.x);
}

/**
 * Splits header cells whose text holds two titles ("Código Ubicación": the
 * PDF joined two cells separated by little more than a space). A split is
 * kept where the data below starts a column; `force` also splits without that
 * evidence (used when the header would otherwise have no code column).
 */
function splitJoinedTitles(cells, below, force) {
  const out = [];
  for (const cell of cells) {
    let words = wordsOf(cell.pieces);
    // The words must read like the cell (band cells join the text of several lines).
    if (words.map((w) => w.text).join(' ') !== cell.text) {
      out.push(cell);
      continue;
    }
    let current = cell;
    for (;;) {
      const index = words.length > 1 ? titleSplit(words.map((w) => w.text).join(' ')) : -1;
      if (index < 0) break;
      const estimate = words[index].x;
      const hits = startsNear(below, estimate, Math.max(cell.h, 4));
      const supported = hits.length >= Math.max(2, Math.ceil(0.3 * below.length));
      if (!supported && !force) break;
      const x = supported ? medianOf(hits, estimate) : estimate;
      out.push({ ...current, end: Math.min(current.end, x), text: words.slice(0, index).map((w) => w.text).join(' ') });
      words = words.slice(index);
      current = { ...current, x, text: words.map((w) => w.text).join(' ') };
    }
    out.push(current);
  }
  if (out.length === cells.length) return cells;
  const classes = detectHeader(out.map((cell) => cell.text));
  return classes ? withClasses(out, classes) : null;
}

/**
 * Document header: the first header band that is not preceded by rows of
 * its own table. Returns { page, start, end, cells, norms } or null.
 */
function findHeader(pages) {
  for (let p = 0; p < pages.length; p++) {
    const { lines } = pages[p];
    for (let i = 0; i < lines.length; i++) {
      const band = headerBand(lines, i);
      if (!band || tableRowsAbove(lines, band) >= 2) continue;
      const below = lines.slice(band.end + 1, band.end + 41);
      let cells = splitJoinedTitles(band.cells, below, false) ?? band.cells;
      if (!cells.some((cell) => cell.cls?.role === 'code')) cells = splitJoinedTitles(cells, below, true) ?? cells;
      const norms = new Set(lines.slice(band.start, band.end + 1).map((line) => line.norm));
      return { page: p, start: band.start, end: band.end, cells, norms };
    }
  }
  return null;
}

/**
 * Header with a single unmistakable title ("Código | Sitio | Texto"): the
 * first line with 2+ cells, when the codes below it have digits.
 */
function findLooseHeader(pages) {
  const page = pages.findIndex((p) => p.lines.length);
  if (page < 0) return null;
  const { lines } = pages[page];
  const index = lines.findIndex((line) => line.segments.length >= 2);
  if (index < 0 || index >= HEADER_SEARCH_LINES) return null;
  const cells = lines[index].segments;
  const tolerance = Math.max(lines[index].h, 4);
  const cellOf = (x) => cells.reduce((best, cell, k) => (x >= cell.x - tolerance ? k : best), 0);
  const below = lines.slice(index + 1, index + 21).map((line) => {
    const texts = cells.map(() => '');
    for (const segment of line.segments) texts[cellOf(segment.x)] = `${texts[cellOf(segment.x)]} ${segment.text}`.trim();
    return texts;
  });
  const classes = detectLooseHeader(cells.map((cell) => cell.text), below);
  if (!classes) return null;
  const headerCells = withClasses(
    cells.map((cell) => ({ x: cell.x, end: cell.end, h: cell.h, text: cell.text, pieces: cell.pieces })),
    classes,
  );
  return { page, start: index, end: index, cells: headerCells, norms: new Set([lines[index].norm]) };
}

const roleSequence = (cells) => cells.map((cell) => cell.cls?.role).filter(Boolean).join(',');

/** Index of the first body line of a page: after the (repeated) header, if any. */
function bodyStart(page, pageIndex, header) {
  if (!header) return 0;
  if (pageIndex === header.page) return header.end + 1;
  const { lines } = page;
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, HEADER_SEARCH_LINES); i++) {
    if (header.norms.has(lines[i].norm)) {
      start = i + 1;
      continue;
    }
    if (start) continue;
    const band = headerBand(lines, i);
    if (band && roleSequence(band.cells) === roleSequence(header.cells)) return band.end + 1;
  }
  return start;
}

// ---------------------------------------------------------------------------
// 4. Page furniture

/** Page numbers, dates, URLs and "Página N de M" (alone or combined, e.g. "25/09/2026    3/5"). */
function isFooterLine(line) {
  if (line.segments.length === 1 && PAGE_MARK.test(line.norm)) return true;
  return line.segments.every((segment) => isFooterPart(textNorm(segment.text)));
}

const segmentKey = (segment, line) => `${textNorm(segment.text)}@${Math.round(segment.x / 8)}@${Math.round(line.y / 4)}`;

/** Segments (text + position) repeated on all pages, or on at least half of them and 3 or more. */
function repeatedSegments(pages) {
  if (pages.length < 2) return new Set();
  const seen = new Map();
  for (const page of pages) {
    const keys = new Set(page.lines.flatMap((line) => line.segments.map((segment) => segmentKey(segment, line))));
    for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const needed = Math.max(Math.ceil(pages.length / 2), Math.min(pages.length, 3));
  return new Set([...seen].filter(([, count]) => count >= needed).map(([key]) => key));
}

/**
 * Removes running headers and footers from the page bodies. Furniture-like
 * lines (page numbers, dates, repeated text) inside the table body are kept:
 * a drawer number or "Nm" wrapped onto its own line is data. Text in the top
 * or bottom margin far from the table is dropped even on one-page files.
 */
function dropFurniture(bodies, pages, warn) {
  const repeated = repeatedSegments(pages);
  const kindOf = (line) => {
    if (isFooterLine(line)) return 'pattern';
    const furniture = line.segments.every((s) => repeated.has(segmentKey(s, line)) || isFooterPart(textNorm(s.text)));
    return furniture ? 'repeated' : null;
  };
  const gaps = [];
  for (const body of bodies) {
    const content = body.lines.filter((line) => !kindOf(line));
    for (let i = 1; i < content.length; i++) gaps.push(content[i].y - content[i - 1].y);
  }
  const pitch = medianOf(gaps, 0);

  const data = [];
  bodies.forEach((body, index) => {
    const { height, number } = pages[index];
    const lines = body.lines.map((line) => ({ ...line, kind: kindOf(line), page: number }));
    const far = (a, b) => !a || !b || Math.abs(b.y - a.y) > Math.max(2.5 * Math.max(a.h, b.h), 2.2 * pitch);
    // Page margins: furniture, or text far from the table (below it at the
    // bottom, above it at the top; a table may start or end in the margin).
    const top = height > 0 ? PAGE_MARGIN * height : -Infinity;
    const bottom = height > 0 ? (1 - PAGE_MARGIN) * height : Infinity;
    const kept = [];
    for (const [i, line] of lines.entries()) {
      const margin = line.y < top || line.y > bottom;
      const neighbour = line.y < top ? lines[i + 1] : kept.at(-1);
      if (margin && (line.kind || far(neighbour, line))) {
        if (!line.kind) warn('skipped_line', `Línea omitida (margen de la página): «${line.text}»`, number);
        continue;
      }
      kept.push(line);
    }
    // Inside the page: furniture-like lines only survive between table lines.
    const first = kept.findIndex((line) => !line.kind);
    const last = kept.findLastIndex((line) => !line.kind);
    kept.forEach((line, i) => {
      if (line.kind) {
        const prev = kept[i - 1];
        const close = prev && line.y - prev.y <= CONTINUATION_GAP * Math.max(line.h, prev.h);
        if (first < 0 || i < first || (i > last && !close)) return;
      }
      data.push(line);
    });
  });
  return { lines: data, pitch };
}

// ---------------------------------------------------------------------------
// 5. Columns

/** Clusters left edges (of segments, or of pieces); returns [{ x, support }] sorted by x. */
function clusterEdges(lines, tolerance, pieces = false) {
  const edges = [];
  lines.forEach((line, lineIndex) => {
    for (const part of pieces ? line.pieces : line.segments) edges.push({ x: part.x, lineIndex });
  });
  edges.sort((a, b) => a.x - b.x);
  const clusters = [];
  for (const edge of edges) {
    const cluster = clusters.at(-1);
    if (cluster && edge.x - cluster.min <= tolerance) {
      cluster.lines.add(edge.lineIndex);
      cluster.max = edge.x;
    } else {
      clusters.push({ min: edge.x, max: edge.x, lines: new Set([edge.lineIndex]) });
    }
  }
  return clusters.map((c) => ({ x: c.min, support: c.lines.size }));
}

/** Empty horizontal gaps inside (lo, hi) not covered by any piece: [{ from, to }]. */
function emptyGaps(lines, lo, hi, isNoise) {
  const spans = [];
  for (const line of lines) {
    for (const span of spansOf(line)) {
      if (span.end > lo && span.x < hi && !isNoise(span)) spans.push([span.x, span.end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = lo;
  for (const [from, to] of spans) {
    if (from > cursor) gaps.push({ from: cursor, to: from });
    cursor = Math.max(cursor, to);
  }
  if (hi > cursor) gaps.push({ from: cursor, to: hi });
  return gaps;
}

/**
 * Column boundaries from the header cells: bounds[k] is the x from which a
 * piece belongs to column k (bounds[0] = -Infinity). For each column:
 *   1. data left-aligned with its title: just before the title;
 *   2. aligned left edges between the previous title and this one (centred
 *      title over left-aligned data): just before those edges;
 *   3. otherwise (centred or right-aligned data) the widest empty gutter.
 * 2 and 3 must not empty the previous column (right-aligned numbers under a
 * left-aligned title belong to that title).
 */
function boundsFromHeader(header, lines) {
  const h = medianHeight(lines.length ? lines : [{ h: header[0].h }]);
  const tolerance = ALIGN_TOLERANCE * h;
  const bounds = [-Infinity];
  const clusters = clusterEdges(lines, tolerance, true);
  const minSupport = Math.max(2, Math.ceil(lines.length * 0.3));
  const spansTitles = (span) => header.some((cell, k) => k > 0 && span.x < header[k - 1].x && span.end > cell.x + tolerance);
  const filledLines = (from, to) => lines.filter((line) => line.pieces.some((p) => p.x >= from && p.x < to)).length;
  for (let k = 1; k < header.length; k++) {
    const title = header[k];
    const fallback = title.x - 0.25 * h;
    const next = header[k + 1]?.x ?? Infinity;
    const aligned = startsNear(lines, title.x, tolerance);
    const inColumn = filledLines(header[k - 1].end, next);
    if (aligned.length >= Math.min(2, lines.length) && aligned.length >= 0.3 * inColumn) {
      // The data may start a little before the title (padding of a centred title).
      bounds.push(Math.min(title.x, medianOf(aligned, title.x)) - 0.25 * h);
      continue;
    }
    const before = filledLines(bounds[k - 1], fallback);
    const keeps = (bound) => filledLines(bounds[k - 1], bound) >= 0.5 * before;
    // Text that starts before the bound but runs under the title belongs to this column.
    const cut = (bound) =>
      lines.filter((line) => spansOf(line).some((s) => s.x < bound && s.x > bounds[k - 1] && s.end > title.x + tolerance && !spansTitles(s))).length;
    const candidates = clusters
      .filter((c) => c.x > header[k - 1].end && c.x < title.x - tolerance && c.support >= minSupport)
      .sort((a, b) => b.support - a.support || b.x - a.x)
      .map((c) => c.x - 0.25 * h);
    const gutters = emptyGaps(lines, header[k - 1].end, title.x, spansTitles)
      .sort((a, b) => b.to - b.from - (a.to - a.from))
      .map((gap) => (gap.from + gap.to) / 2);
    let best = { bound: fallback, cut: cut(fallback) };
    for (const bound of [...candidates, ...gutters]) {
      if (!keeps(bound)) continue;
      const count = cut(bound);
      if (count < best.cut || (best.bound === fallback && count === best.cut)) best = { bound, cut: count };
    }
    bounds.push(best.bound);
  }
  return bounds;
}

/** Column bounds without header: left edges shared by many lines. */
function inferBounds(dataLines) {
  const h = medianHeight(dataLines);
  const tolerance = ALIGN_TOLERANCE * h;
  const clusters = clusterEdges(dataLines, tolerance);
  const top = Math.max(0, ...clusters.map((c) => c.support));
  const minSupport = Math.max(2, Math.ceil(top * 0.3));
  const starts = clusters.filter((c) => c.support >= minSupport).map((c) => c.x);
  if (!starts.length) starts.push(Math.min(...dataLines.map((l) => l.segments[0].x)));
  return { starts, bounds: starts.map((x, k) => (k ? x - 0.25 * h : -Infinity)) };
}

function columnOf(x, bounds) {
  let index = 0;
  for (let k = 1; k < bounds.length; k++) if (x >= bounds[k]) index = k;
  return index;
}

/**
 * Splits a piece that runs across the start of a later column (at the space
 * nearest to that start). Returns the parts with their column index.
 */
function splitAcrossColumns(piece, bounds, h) {
  const parts = [];
  let rest = piece;
  let col = columnOf(piece.x, bounds);
  for (;;) {
    const next = bounds[col + 1];
    if (next === undefined || rest.x + rest.w <= next + 0.5 * h || rest.str.length < 2) break;
    const charW = rest.w / rest.str.length;
    // The space nearest to the column start. Widths are proportional estimates: a
    // generator that joined several cells in one text (gaps read as one space)
    // shifts them, so the search reaches 2 font heights around the start.
    const target = next + 0.25 * h - charW;
    let cut = -1;
    for (let i = rest.str.indexOf(' ', 1); i > 0 && i < rest.str.length - 1; i = rest.str.indexOf(' ', i + 1)) {
      if (cut < 0 || Math.abs(rest.x + i * charW - target) < Math.abs(rest.x + cut * charW - target)) cut = i;
    }
    if (cut < 0 || Math.abs(rest.x + cut * charW - target) > Math.max(3.5 * charW, 2 * h)) break;
    const left = rest.str.slice(0, cut).trimEnd();
    const right = rest.str.slice(cut + 1).trimStart();
    const rightStart = rest.str.length - right.length;
    parts.push({ ...rest, str: left, w: left.length * charW, col });
    rest = { ...rest, x: rest.x + rightStart * charW, w: right.length * charW, str: right };
    // The text after the cut belongs at least to the next column.
    col = Math.max(col + 1, columnOf(rest.x, bounds));
  }
  parts.push({ ...rest, col });
  return parts;
}

/**
 * Distributes the pieces of a line into column cells. Returns { cells,
 * splitSources, crossing } where crossing is the largest number of columns
 * one piece of the line spans.
 */
function lineCells(line, bounds) {
  const buckets = bounds.map(() => []);
  const columnsBySource = new Map();
  let crossing = 1;
  for (const piece of line.pieces) {
    const lastCol = columnOf(piece.x + piece.w - 0.5 * line.h, bounds);
    crossing = Math.max(crossing, lastCol - columnOf(piece.x, bounds) + 1);
    for (const part of splitAcrossColumns(piece, bounds, line.h)) {
      buckets[part.col].push(part);
      if (!columnsBySource.has(part.src)) columnsBySource.set(part.src, new Set());
      columnsBySource.get(part.src).add(part.col);
    }
  }
  let splitSources = 0;
  for (const cols of columnsBySource.values()) if (cols.size > 1) splitSources++;
  return { cells: buckets.map((parts) => joinPieces(parts)), splitSources, crossing };
}

// ---------------------------------------------------------------------------
// 6. Lines that are not table rows

function looksLikeProse(text) {
  return SUMMARY_LINE.test(text) || text.includes(': ') || text.endsWith(':') || text.split(' ').length >= 4;
}

/**
 * Word count and digits of the codes of the regular rows (no text across
 * columns), to recognise text that is not a code.
 */
function codeShape(lines, codeCol) {
  const codes = lines.filter((line) => line.crossing === 1).map((line) => line.cells[codeCol]).filter(Boolean);
  const words = codes.map((code) => code.split(' ').length).sort((a, b) => a - b);
  return {
    maxWords: words.length ? Math.max(2, words[Math.floor(0.9 * (words.length - 1))] + 1) : Infinity,
    digits: codes.length ? codes.filter((code) => /\d/.test(code)).length / codes.length : 0,
  };
}

/**
 * Removes lines that are not table rows: summaries and signatures ("Total:",
 * "Revisado por: …"), sentences written across several columns whose start
 * does not look like the codes of the table, and blocks of text separated
 * from the table by a large gap without a single row (notes, legends).
 */
function dropProse(lines, codeCol, pitch, warn) {
  const skip = (line) => warn('skipped_line', `Línea omitida: «${line.text}»`, line.page);
  const shape = codeShape(lines, codeCol);
  const fitsCode = (text) => text.split(' ').length <= shape.maxWords && (shape.digits < 0.8 || /\d/.test(text));
  const across = (line) => line.pieces.length === 1 && line.crossing >= 2;
  const sentence = (line) => across(line) && line.cells[codeCol] && !fitsCode(line.cells[codeCol]);
  const rowLike = (line) => {
    const code = line.cells[codeCol];
    return Boolean(code) && fitsCode(code) && !looksLikeProse(code) && !across(line);
  };

  const kept = [];
  for (const line of lines) {
    const code = line.cells[codeCol];
    const filled = line.cells.filter(Boolean).length;
    if (sentence(line) || (code && (SUMMARY_LINE.test(code) || code.includes(': ') || code.endsWith(':'))) || (code && filled === 1 && looksLikeProse(code))) {
      skip(line);
      continue;
    }
    kept.push(line);
  }

  // Blocks after a large vertical gap without a single row are notes under the table.
  const out = [];
  let block = [];
  const flush = () => {
    if (block.detached && !block.some(rowLike)) block.forEach(skip);
    else out.push(...block);
    block = [];
  };
  kept.forEach((line, i) => {
    const prev = kept[i - 1];
    const newPage = !prev || prev.page !== line.page;
    if (newPage || line.y - prev.y > Math.max(2.5 * line.h, 2.2 * pitch)) {
      flush();
      block.detached = !newPage;
    }
    block.push(line);
  });
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// 7. Rows

const joinCell = (a, b) => (a && b ? `${a} ${b}` : a || b);

/**
 * Groups data lines into rows. A line with a code starts a row; the lines
 * without code between two rows belong to the row above (text aligned to the
 * top of the cells), to the row below (bottom) or are split (centred). The
 * boundary between two rows is the largest vertical gap between them, since
 * the cell padding makes rows further apart than the lines inside a cell.
 * Runs where the gaps do not tell use the alignment learned from the rest of
 * the document (top by default).
 */
function buildRows(lines, codeCol, warn) {
  const rows = [];
  const runs = [];
  let run = null;
  let prev = null;
  let page = null;
  for (const line of lines) {
    if (line.page !== page) {
      if (run) runs.push(run);
      run = null;
      prev = null;
      page = line.page;
    }
    if (line.cells[codeCol]) {
      const row = { line, above: [], below: [], page: line.page };
      rows.push(row);
      if (run) runs.push({ ...run, next: row });
      run = null;
      prev = row;
    } else {
      run ??= { lines: [], prev, next: null, before: rows.at(-1) ?? null };
      run.lines.push(line);
    }
  }
  if (run) runs.push(run);

  // Decisive runs vote for the alignment and tell the leading inside a cell.
  const learn = () => {
    const votes = { top: 0, bottom: 0, middle: 0 };
    const inCell = [];
    for (const r of runs) {
      r.split = undefined;
      if (!r.prev || !r.next || !r.lines.length) continue;
      const seq = [r.prev.line, ...r.lines, r.next.line];
      const gaps = seq.slice(1).map((line, j) => line.y - seq[j].y);
      const order = gaps.map((_, j) => j).sort((a, b) => gaps[b] - gaps[a]);
      const h = Math.max(...seq.map((line) => line.h));
      if (gaps[order[0]] - gaps[order[1]] <= Math.max(0.2, 0.02 * h)) {
        // Undecided, but clearly smaller gaps are still lines of one cell.
        for (const gap of gaps) if (gap < 0.8 * gaps[order[0]]) inCell.push(gap);
        continue;
      }
      r.split = order[0];
      votes[r.split === 0 ? 'bottom' : r.split === r.lines.length ? 'top' : 'middle']++;
      gaps.forEach((gap, j) => j !== r.split && inCell.push(gap));
    }
    return { votes, lead: medianOf(inCell, 0) };
  };
  const alignment = ({ top, bottom, middle }) => {
    const total = top + bottom + middle;
    if (middle > 0.25 * total || (top >= 0.25 * total && bottom >= 0.25 * total && total)) return 'middle';
    return bottom > top ? 'bottom' : 'top';
  };
  let { votes, lead } = learn();
  // A line further than the leading from both neighbours is a row whose code
  // cell is empty, not wrapped text: it is left out instead of being glued to
  // another tool. Only known when the document has wrapped cells aligned to the
  // top or the bottom (centred cells also have lines half a leading apart).
  if (lead > 0 && alignment(votes) !== 'middle') {
    let removed = false;
    for (const r of runs) {
      if (!r.prev) continue;
      const seq = [r.prev.line, ...r.lines, ...(r.next ? [r.next.line] : [])];
      const alone = r.lines.filter((line, j) => {
        const next = seq[j + 2];
        return line.y - seq[j].y > 1.25 * lead && (!next || next.y - line.y > 1.25 * lead);
      });
      for (const line of alone) warn('skipped_line', `Fila sin código (no se importa): «${line.text}»`, line.page);
      if (alone.length) {
        r.lines = r.lines.filter((line) => !alone.includes(line));
        removed = true;
      }
    }
    if (removed) ({ votes, lead } = learn());
  }
  const align = alignment(votes);
  const close = (a, b) => b.y - a.y <= Math.max(CONTINUATION_GAP * Math.max(a.h, b.h), 1.3 * lead);

  const orphan = (r) => {
    for (const line of r.lines) warn('continuation_orphan', `Texto sin código al que asociarlo: «${line.text}»`, line.page);
  };
  for (const r of runs) {
    if (r.prev && r.next) {
      const split = r.split ?? { top: r.lines.length, bottom: 0, middle: Math.ceil(r.lines.length / 2) }[align];
      r.prev.below.push(...r.lines.slice(0, split));
      r.next.above.push(...r.lines.slice(split));
    } else if (r.prev) {
      r.prev.below.push(...r.lines);
    } else {
      // Top of a page: the end of the previous page's last row (top aligned
      // rows split across pages) or the start of the next row.
      const { before } = r;
      const toNext = r.next && [...r.lines, r.next.line].every((line, j, all) => j === 0 || close(all[j - 1], line));
      if (align === 'top' && before) before.below.push(...r.lines);
      else if (toNext) r.next.above.push(...r.lines);
      else if (before) before.below.push(...r.lines);
      else orphan(r);
    }
  }

  return rows.map((row) => {
    let cells = row.above.reduce((acc, line) => acc.map((c, k) => joinCell(c, line.cells[k])), row.line.cells.map(() => ''));
    cells = cells.map((c, k) => joinCell(c, row.line.cells[k]));
    for (const line of row.below) cells = cells.map((c, k) => joinCell(c, line.cells[k]));
    return { cells, page: row.page };
  });
}

// ---------------------------------------------------------------------------
// Several tables side by side

/**
 * A header whose roles repeat on the same line ("Código Ubicación Comentario
 * Código Ubicación Comentario"): the page holds several tables side by side.
 * Returns the left edge of every block (its first title), or null.
 */
function tableBlocks(cells) {
  const roles = cells.map((cell) => cell.cls?.role ?? '-');
  for (let count = 2; count <= 4; count++) {
    if (roles.length % count) continue;
    const size = roles.length / count;
    const first = roles.slice(0, size).join(',');
    if (!first.includes('code')) continue;
    let same = true;
    for (let b = 1; b < count && same; b++) same = roles.slice(b * size, (b + 1) * size).join(',') === first;
    if (same) return Array.from({ length: count }, (_, b) => cells[b * size].x);
  }
  return null;
}

/**
 * Reads side-by-side tables one after the other: every page becomes one page
 * per block, with the pieces of each block moved under the first block.
 */
function unfoldBlocks(pages, lefts, h) {
  const edges = [...lefts.map((x, b) => (b ? x - 0.25 * h : -Infinity)), Infinity];
  return pages.flatMap((page) =>
    lefts.map((left, b) => {
      const shift = left - lefts[0];
      const pieces = page.lines.flatMap((line) => line.pieces.filter((p) => p.x >= edges[b] && p.x < edges[b + 1]));
      return { ...page, lines: groupLines(pieces.map((p) => ({ ...p, x: p.x - shift }))) };
    }),
  );
}

// ---------------------------------------------------------------------------
// Entry points

/**
 * Runs the layout analysis on already extracted text items, without pdf.js.
 * `pages` = [{ items: [{ str, x, y, w, h }], height? }] with y growing
 * downwards (baseline). Used by tests to reproduce the output of other PDF
 * generators.
 */
export function analyseItems(pages, options) {
  return analysePages(
    pages.map((page, index) => ({
      number: index + 1,
      height: page.height ?? 0,
      lines: groupLines(page.items.filter((item) => item.str.trim()).flatMap((item) => splitItem(item))),
    })),
    options,
  );
}

/**
 * Layout analysis on grouped lines: `pages` = [{ number, height, lines: groupLines(pieces) }].
 * Returns the parse result of SPEC §5 (source "pdf"); throws ImportError EMPTY / TOO_MANY_ROWS.
 */
export function analysePages(pages, { maxRows = Infinity } = {}) {
  const warnings = [];
  let dropped = 0;
  const warn = (type, message, page = null) => {
    if (warnings.length < MAX_WARNINGS) warnings.push({ type, message, page });
    else dropped++;
  };
  const pageCount = pages.length;

  let header = findHeader(pages);
  const blocks = header && tableBlocks(header.cells);
  if (blocks) {
    pages = unfoldBlocks(pages, blocks, header.cells[0].h);
    header = findHeader(pages);
    warn('several_tables', `Hay ${blocks.length} tablas en cada página, una al lado de otra: se han leído una detrás de otra.`);
  }
  header ??= findLooseHeader(pages);

  const bodies = pages.map((page, index) => ({ lines: page.lines.slice(bodyStart(page, index, header)) }));
  const { lines: bodyLines, pitch } = dropFurniture(bodies, pages, warn);

  let bounds;
  let dataLines = bodyLines;
  if (header) {
    bounds = boundsFromHeader(header.cells, bodyLines);
  } else if (bodyLines.length) {
    const inferred = inferBounds(bodyLines);
    bounds = inferred.bounds;
    // Without a header, lines that do not start on a column (centred titles…) are not table rows.
    dataLines = bodyLines.filter((line) => {
      const tolerance = ALIGN_TOLERANCE * line.h;
      const ok = inferred.starts.some((s) => Math.abs(line.segments[0].x - s) <= tolerance);
      if (!ok) warn('skipped_line', `Línea omitida (fuera de las columnas): «${line.text}»`, line.page);
      return ok;
    });
  } else {
    bounds = [-Infinity];
  }

  const splitByPage = new Map();
  for (const line of dataLines) {
    Object.assign(line, lineCells(line, bounds));
    if (line.splitSources) splitByPage.set(line.page, (splitByPage.get(line.page) ?? 0) + line.splitSources);
  }

  // Header-like lines inside the body: exact repeats are skipped silently, other
  // lines only when every cell is a title of the same column role.
  if (header) {
    dataLines = dataLines.filter((line) => {
      if (header.norms.has(line.norm)) return false;
      const filled = line.cells.map((cell, k) => [cell, k]).filter(([cell]) => cell);
      const titles =
        filled.length >= 2 &&
        filled.every(([cell, k]) => classifyHeaderCell(cell)?.role === header.cells[k]?.cls?.role && header.cells[k]?.cls);
      if (titles) warn('skipped_line', `Línea omitida (parece una cabecera): «${line.text}»`, line.page);
      return !titles;
    });
  }

  const columnCount = bounds.length;
  let mapping;
  let rows;
  if (header) {
    const cellRows = dataLines.map((line) => ({ cells: line.cells }));
    mapping = mappingFromHeader(
      header.cells.map((cell) => cell.cls),
      header.cells.map((cell) => cell.text),
      cellRows,
    );
    const codeCol = mapping.code >= 0 ? mapping.code : 0;
    dataLines = dropProse(dataLines, codeCol, pitch, warn);
    rows = buildRows(dataLines, codeCol, warn);
  } else {
    warn('no_header', 'No se ha encontrado una fila de cabecera; las columnas se han asignado por su contenido.');
    // First pass: guess the code column from the raw lines, then refine on the merged rows.
    const first = inferMapping(dataLines.map((line) => ({ cells: line.cells })), columnCount);
    const scratch = [];
    const collect = (...args) => scratch.push(args);
    const firstCode = Math.max(0, first.code);
    let lines = dropProse(dataLines, firstCode, pitch, collect);
    rows = buildRows(lines, firstCode, collect);
    mapping = inferMapping(rows, columnCount);
    if (mapping.code !== firstCode && mapping.code >= 0) {
      scratch.length = 0;
      lines = dropProse(dataLines, mapping.code, pitch, collect);
      rows = buildRows(lines, mapping.code, collect);
    }
    for (const args of scratch) warn(...args);
  }
  for (const [page, count] of splitByPage) {
    warn('split_merged', `Se han separado ${count} textos que ocupaban varias columnas.`, page);
  }

  if (dropped) warnings.push({ type: 'skipped_line', message: `Y ${dropped} avisos más.`, page: null });
  if (rows.length === 0) throw new ImportError('EMPTY');
  if (rows.length > maxRows) throw tooManyRows(maxRows);

  return {
    source: 'pdf',
    pages: pageCount,
    columnCount,
    headers: header ? header.cells.map((cell) => cell.text) : null,
    mapping,
    mappingSource: header ? 'header' : 'heuristic',
    rows,
    warnings,
  };
}
