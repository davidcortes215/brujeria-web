// PDF import at the pdf.js API level: open the document, read the text items of every
// page (upright text only, with a budget) and hand them to the layout analysis
// (layout.js). The pdf.js library object is a parameter, so the same code runs on the
// server (pdfjs-dist from node_modules, importer/pdf.js) and in the browser demo
// (pdfjs-dist from a CDN). No Node.js imports.

import { IMPORT_ERROR_MESSAGES, ImportError } from './columns.js';
import { analysePages, groupLines, splitItem } from './layout.js';

export { ImportError };

export const MAX_PAGES = 2000;
export const MAX_TEXT_ITEMS = 500_000;

/** getDocument() options for text extraction only (no eval, no fonts loaded into the page). */
const DOCUMENT_DEFAULTS = Object.freeze({
  isEvalSupported: false,
  useSystemFonts: false,
  disableFontFace: true,
  verbosity: 0,
});

/** True when the first KB carries the "%PDF-" signature. */
export function looksLikePdf(bytes) {
  const head = bytes.subarray(0, 1024);
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]); // latin1
  return text.includes('%PDF-');
}

/** Upright text pieces of a page (rotated watermarks and vertical labels are ignored). */
export function extractPieces(pdfjs, items, viewport) {
  const pieces = [];
  let textItems = 0;
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    textItems++;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    // Only upright horizontal text; rotated watermarks and vertical labels are ignored.
    if (!(tx[0] > 0) || Math.abs(tx[1]) > 0.1 * tx[0]) continue;
    const h = Math.hypot(tx[2], tx[3]) || item.height || 10;
    const w = item.width > 0 ? item.width : item.str.length * h * 0.5;
    pieces.push(...splitItem({ x: tx[4], y: tx[5], w, h, str: item.str }));
  }
  return { pieces, textItems };
}

/** Text items of a page, read as a stream so that absurd pages stop early. */
export async function readTextItems(page, budget) {
  const reader = page.streamTextContent().getReader();
  const items = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const item of value.items) items.push(item);
    if (budget.items + items.length > MAX_TEXT_ITEMS) {
      await reader.cancel().catch(() => {});
      throw new ImportError('TOO_COMPLEX');
    }
  }
  budget.items += items.length;
  return items;
}

/**
 * Parses a PDF with the given pdf.js library (`pdfjs-dist` module namespace).
 * @param {object} pdfjs pdf.js library: { getDocument, Util }
 * @param {Uint8Array|ArrayBuffer} input file contents (copied: pdf.js may detach what it receives)
 * @param {{maxRows?: number, documentOptions?: object}} [options] `documentOptions` are merged into
 *   the getDocument() parameters (e.g. standardFontDataUrl, cMapUrl on the server)
 * @returns {Promise<{source:'pdf', pages:number, columnCount:number, headers:string[]|null,
 *   mapping:{code:number,location:number,description:number}, mappingSource:'header'|'heuristic',
 *   rows:{cells:string[], page:number}[], warnings:{type:string, message:string, page:number|null}[]}>}
 *   rejects with ImportError (INVALID_PDF, NO_TEXT, EMPTY, TOO_MANY_ROWS, TOO_COMPLEX)
 */
export async function readPdf(pdfjs, input, { maxRows = Infinity, documentOptions = {} } = {}) {
  const data = new Uint8Array(ArrayBuffer.isView(input) ? input : new Uint8Array(input)); // private copy
  if (!looksLikePdf(data)) throw new ImportError('INVALID_PDF');

  const task = pdfjs.getDocument({ ...DOCUMENT_DEFAULTS, ...documentOptions, data });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    if (err?.name === 'PasswordException') throw new ImportError('INVALID_PDF', IMPORT_ERROR_MESSAGES.ENCRYPTED_PDF);
    throw new ImportError('INVALID_PDF');
  }

  try {
    if (doc.numPages > MAX_PAGES) {
      throw new ImportError('TOO_COMPLEX', `El PDF tiene demasiadas páginas (máximo ${MAX_PAGES}). Divídelo en varios archivos.`);
    }
    const pages = [];
    const unreadable = [];
    const empty = [];
    const budget = { items: 0 };
    let textItems = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      let page = null;
      try {
        page = await doc.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const extracted = extractPieces(pdfjs, await readTextItems(page, budget), viewport);
        textItems += extracted.textItems;
        if (!extracted.textItems) empty.push(number);
        pages.push({ number, height: viewport.height, lines: groupLines(extracted.pieces) });
      } catch (err) {
        if (err instanceof ImportError) throw err;
        // A damaged page should not prevent importing the rest of the document.
        unreadable.push(number);
        pages.push({ number, height: 0, lines: [] });
      } finally {
        page?.cleanup();
      }
    }
    if (unreadable.length === doc.numPages) throw new ImportError('INVALID_PDF');
    if (textItems === 0) throw new ImportError('NO_TEXT');
    const result = analysePages(pages, { maxRows });
    for (const number of empty.reverse()) {
      result.warnings.unshift({
        type: 'page_without_text',
        message: `La página ${number} no tiene texto (¿está escaneada?): sus útiles no se importarán.`,
        page: number,
      });
    }
    for (const number of unreadable) {
      result.warnings.unshift({ type: 'skipped_line', message: `No se ha podido leer la página ${number}.`, page: number });
    }
    return result;
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError('INVALID_PDF');
  } finally {
    await task.destroy().catch(() => {});
  }
}
