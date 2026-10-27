// PDF reading in the demo: pdf.js (same version as the server's node_modules/pdfjs-dist)
// from the jsDelivr CDN, run in the page itself. Workers from other origins are not
// allowed, so the worker module is imported here: it defines globalThis.pdfjsWorker and
// pdf.js then uses its in-page "fake worker". The extraction and layout analysis are the
// server's own modules (lib/importer/pdf-document.js, layout.js).

import { readPdf } from '../lib/importer/pdf-document.js';
import { PDFJS_VERSION } from './build-info.js';

const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`;

/** pdf.js could not be loaded (no internet connection, CDN blocked). */
export class PdfReaderUnavailable extends Error {
  constructor(cause) {
    super('No se ha podido cargar el lector de PDF.');
    this.name = 'PdfReaderUnavailable';
    this.cause = cause;
  }
}

let loading = null;

function loadPdfjs() {
  if (!loading) {
    loading = (async () => {
      const worker = await import(`${CDN}pdf.worker.min.mjs`);
      if (!globalThis.pdfjsWorker?.WorkerMessageHandler) {
        globalThis.pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
      }
      return import(`${CDN}pdf.min.mjs`);
    })();
    loading.catch(() => {
      loading = null; // try again on the next import
    });
  }
  return loading;
}

/** Parses PDF bytes like the server's importer (SPEC §5); rejects with ImportError or PdfReaderUnavailable. */
export async function parsePdfBytes(bytes, { maxRows = Infinity } = {}) {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (err) {
    throw new PdfReaderUnavailable(err);
  }
  return readPdf(pdfjs, bytes, {
    maxRows,
    // Text only: nothing else is downloaded (no standard fonts, CMaps or WebAssembly decoders).
    documentOptions: { useWorkerFetch: false, useWasm: false, isOffscreenCanvasSupported: false },
  });
}
