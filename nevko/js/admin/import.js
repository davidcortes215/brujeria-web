// #/admin/importar — catalogue import (SPEC §5, §7):
//   1. Choose a PDF or CSV (drag & drop anywhere on the page, or the file picker). It is
//      sent as a raw body to POST /admin/import/parse (Content-Type + X-Filename).
//   2. Review: file summary and reading warnings, preview of the first 50 rows with a
//      role per column (Código / Ubicación / Descripción / Ignorar; Código exactly once),
//      differences against the catalogue (POST /admin/import/diff, re-run whenever the
//      mapping changes or the catalogue changes) and the import mode (merge / replace).
//   3. Confirm -> POST /admin/import/commit -> result.
// Nothing changes in the catalogue before step 3. The session is kept in env.store, so
// switching to another section and back returns to the same step.
// The diff also reports tools whose code is written differently in the file ("renamed":
// same tool, keeps its history), over-long texts that will be cut ("truncated"), codes
// of the file that are the same code written two ways ("similar") and codes with several
// rows ("multiUnit": each row is one unit of that code, "Unidad 2 de 3"; not an error). A role without a
// column (e.g. no Ubicación) is left out of the rows, which the server currently reads as
// '' (it empties that field in the tools that already exist): the review and the
// confirmation say how many and turn red.

import { alertBox, button, card, select, spinner, tag, unitTag } from '../components.js';
import { h, replace } from '../dom.js';
import * as fmt from '../fmt.js';
import { icon } from '../icons.js';
import * as ui from '../ui.js';
import { IMPORT_MODE_LABELS, adminRequest, debounce, inlineError, pageHeader, reportError } from './common.js';

const PREVIEW_ROWS = 50;
const MAX_LISTED_ISSUES = 200;
const MB = 1024 * 1024;
const MAX_BYTES = { pdf: 30 * MB, csv: 10 * MB };
const PARSE_TIMEOUT_MS = 180_000;
const DIFF_TIMEOUT_MS = 60_000;
const COMMIT_TIMEOUT_MS = 120_000;
const DIFF_DELAY_MS = 150;
const REFRESH_DELAY_MS = 400;

const ROLE_OPTIONS = [
  { value: 'code', label: 'Código' },
  { value: 'location', label: 'Ubicación' },
  { value: 'description', label: 'Descripción' },
  { value: 'ignore', label: 'Ignorar' },
];
const ROLE_KEYS = ['code', 'location', 'description'];

const WARNING_LABELS = {
  skipped_line: 'Línea omitida',
  no_header: 'Sin cabecera',
  continuation_orphan: 'Texto suelto',
  split_merged: 'Columnas separadas',
};

const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'numbers']);
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf', 'pages']);
const CSV_EXTENSIONS = new Set(['csv', 'txt', 'tsv']);
const ACCEPT = '.pdf,.csv,.txt,.tsv,application/pdf,text/csv,text/plain';

const EXCEL_TIP = 'En Excel: Archivo › Guardar como › «CSV UTF-8 (delimitado por comas)». En LibreOffice: Guardar como › «Texto CSV».';

// ---------------------------------------------------------------------------
// Pure helpers

/** Singular / plural sentence: plural(3, '1 útil', (n) => `${n} útiles`) -> '3 útiles' (Spanish number format). */
function plural(count, one, many) {
  return count === 1 ? one : many(fmt.number(count));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1).replace('.', ',')} MB`;
}

function extensionOf(name) {
  return (/\.([^.\\/]+)$/.exec(name || '')?.[1] ?? '').toLowerCase();
}

/** Decides how to send the file, or explains why it cannot be imported. */
async function inspectFile(file) {
  const name = file.name || 'archivo';
  const ext = extensionOf(name);
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return {
      error: {
        title: 'Las hojas de cálculo no se importan directamente',
        text: `Guarda «${name}» como CSV y súbelo de nuevo.`,
        tips: [EXCEL_TIP],
      },
    };
  }
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return {
      error: {
        title: 'Formato no admitido',
        text: `Guarda «${name}» como PDF (Archivo › Guardar como › PDF) y súbelo de nuevo.`,
      },
    };
  }
  if (file.size === 0) return { error: { title: 'El archivo está vacío', text: `«${name}» no tiene contenido.` } };

  let kind = ext === 'pdf' ? 'pdf' : CSV_EXTENSIONS.has(ext) ? 'csv' : null;
  if (!kind) {
    let head = '';
    try {
      head = await file.slice(0, 1024).text();
    } catch {
      head = '';
    }
    if (head.includes('%PDF-')) kind = 'pdf';
    else if (file.type === 'application/pdf') kind = 'pdf';
    else if (/^text\//.test(file.type)) kind = 'csv';
  }
  if (!kind) {
    return {
      error: {
        title: 'Formato no admitido',
        text: `«${name}» no es un PDF ni un CSV.`,
        tips: ['Exporta el listado de utillaje a PDF o a CSV desde el programa donde lo tengas.', EXCEL_TIP],
      },
    };
  }
  if (file.size > MAX_BYTES[kind]) {
    return {
      error: {
        title: 'El archivo es demasiado grande',
        text: `«${name}» ocupa ${formatBytes(file.size)}. El máximo es ${kind === 'pdf' ? '30 MB para PDF' : '10 MB para CSV'}.`,
      },
    };
  }
  const contentType = kind === 'pdf' ? 'application/pdf' : ext === 'csv' ? 'text/csv' : 'text/plain';
  return { kind, contentType };
}

/** Friendly explanation of a parse error (SPEC §5 error codes). */
function describeParseError(err, fileName) {
  switch (err.code) {
    case 'NO_TEXT':
      return {
        title: 'El PDF no contiene texto seleccionable',
        text: 'Parece un documento escaneado o una foto: Nevko necesita el texto del PDF para leer los códigos y no puede leer imágenes.',
        tips: [
          'Lo mejor: exporta el listado a CSV desde el programa u hoja de cálculo donde se creó.',
          'O vuelve a generar el PDF desde ese programa (Imprimir › Guardar como PDF), no escaneando el papel.',
          'Si solo tienes el papel, pásalo antes por un programa de reconocimiento de texto (OCR).',
        ],
      };
    case 'INVALID_PDF':
      return {
        title: 'No se ha podido abrir el PDF',
        text: err.message,
        tips: ['Comprueba que el archivo se abre bien en el ordenador.', 'Si tiene contraseña, guarda una copia sin protección.'],
      };
    case 'UNSUPPORTED_TYPE':
      return { title: 'Formato no admitido', text: 'Solo se pueden importar archivos PDF o CSV.', tips: [EXCEL_TIP] };
    case 'EMPTY':
      return {
        title: 'No se ha encontrado ninguna fila',
        text: err.message,
        tips: ['Comprueba que el archivo contiene una tabla con el código, la ubicación y la descripción de cada útil.'],
      };
    case 'TOO_MANY_ROWS': {
      const max = /m[aá]ximo\s+([\d.]+)/i.exec(err.message || '')?.[1]?.replace(/\./g, '');
      return {
        title: 'El archivo tiene demasiadas filas',
        text: max
          ? `Nevko importa hasta ${fmt.number(Number(max))} útiles de una vez y «${fileName}» tiene más.`
          : `«${fileName}» tiene más filas de las que se pueden importar de una vez.`,
        tips: [
          'Divide el listado en varios archivos y súbelos uno detrás de otro con el modo «Actualizar y añadir».',
          'Comprueba que el archivo no incluye filas vacías o de otras tablas al final.',
        ],
      };
    }
    case 'TOO_COMPLEX':
      return {
        title: 'El archivo es demasiado complejo para leerlo',
        text: err.message || `«${fileName}» tiene demasiadas páginas o elementos.`,
        tips: [
          'Lo más fiable: exporta el listado a CSV desde el programa u hoja de cálculo donde se creó.',
          'Si es un PDF muy largo, divídelo en varios archivos más pequeños y súbelos uno detrás de otro con «Actualizar y añadir».',
        ],
      };
    case 'TIMEOUT':
      return {
        title: 'El análisis ha tardado demasiado',
        text: `El servidor no ha terminado de leer «${fileName}». Si el PDF es muy grande, prueba a exportar el listado a CSV.`,
      };
    default:
      if (err.status === 413) {
        return { title: 'El archivo es demasiado grande', text: 'El máximo es 30 MB para PDF y 10 MB para CSV.' };
      }
      return { title: 'No se ha podido leer el archivo', text: err.message || 'Ha ocurrido un error inesperado.' };
  }
}

function columnCount(parse) {
  let count = Number(parse.columnCount) || 0;
  if (Array.isArray(parse.headers)) count = Math.max(count, parse.headers.length);
  for (const row of parse.rows) count = Math.max(count, Array.isArray(row?.cells) ? row.cells.length : 0);
  return Math.max(count, 1);
}

/** Role per column from the server mapping ({ code: 0, location: 1, description: 2 }, -1 = none). */
function rolesFromMapping(parse) {
  const roles = Array.from({ length: columnCount(parse) }, () => 'ignore');
  for (const role of ROLE_KEYS) {
    const index = parse.mapping?.[role];
    if (Number.isInteger(index) && index >= 0 && index < roles.length && roles[index] === 'ignore') roles[index] = role;
  }
  return roles;
}

/**
 * Rows for /import/diff and /import/commit. A role without a column is left out of the
 * row (not sent as ''); today the server still reads it as '' (the review warns that it
 * empties that field), and a server that keeps missing fields needs no client change.
 */
function buildRows(parse, roles) {
  const at = Object.fromEntries(ROLE_KEYS.map((role) => [role, roles.indexOf(role)]));
  const cell = (row, index) => (Array.isArray(row?.cells) ? String(row.cells[index] ?? '') : '');
  return parse.rows.map((row) => {
    const out = {};
    for (const role of ROLE_KEYS) if (at[role] >= 0) out[role] = cell(row, at[role]);
    return out;
  });
}

const FIELD_NAMES = { location: 'la ubicación', description: 'la descripción' };
const FIELD_LIMITS = { location: 200, description: 1000 };

/** "La ubicación supera los 200 caracteres: se importará recortada." for a truncated row. */
function truncatedText(item) {
  const fields = Array.isArray(item.fields) ? item.fields.filter((field) => FIELD_LIMITS[field]) : [];
  if (!fields.length) return item.message || 'Un texto es demasiado largo y se importará recortado.';
  return fields
    .map((field) => {
      const name = FIELD_NAMES[field];
      return `${name[0].toUpperCase()}${name.slice(1)} supera los ${fmt.number(FIELD_LIMITS[field])} caracteres: se importará recortada.`;
    })
    .join(' ');
}

/**
 * Existing tools that would lose a field because its role has no column (buildRows sends
 * ''): { role, count, exact }. `exact` is false when the change list was cut by the server
 * and `count` is then the number of updated tools (an upper bound).
 */
function erasedFields(session) {
  const diff = session.diff;
  if (!diff) return [];
  const updates = (diff.changes ?? []).filter((c) => c.kind === 'updated' || c.kind === 'renamed');
  const complete = updates.length >= (diff.counts?.updated ?? 0);
  return ['location', 'description']
    .filter((role) => !session.roles.includes(role))
    .map((role) => {
      const listed = updates.filter((c) => c.before?.[role] && !c.after?.[role]).length;
      return complete ? { role, count: listed, exact: true } : { role, count: diff.counts?.updated ?? listed, exact: false };
    })
    .filter((item) => item.count > 0);
}

function erasedSentence({ role, count, exact }) {
  const what = FIELD_NAMES[role];
  if (!exact) return `Se borrará ${what} de hasta ${fmt.tools(count)} que ya existen.`;
  return count === 1 ? `Se borrará ${what} de 1 útil que ya existe.` : `Se borrará ${what} de ${fmt.number(count)} útiles que ya existen.`;
}

/** Tools that the import would leave in the catalogue (new + updated + unchanged). */
function validCount(diff) {
  const c = diff?.counts ?? {};
  return (c.new ?? 0) + (c.updated ?? 0) + (c.unchanged ?? 0);
}

function columnName(parse, index) {
  const header = Array.isArray(parse.headers) ? String(parse.headers[index] ?? '').trim() : '';
  return header || `Columna ${index + 1}`;
}

/** "Fila 12 · pág. 3" / "Fila 12 · línea 14" for an input row index. */
function rowLabel(parse, index) {
  const row = parse.rows[index];
  const parts = [`Fila ${fmt.number(index + 1)}`];
  if (row?.page) parts.push(`pág. ${row.page}`);
  else if (row?.line) parts.push(`línea ${row.line}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Page

export function mountImport(root, env) {
  env.store.session ??= { phase: 'idle' };
  if (env.store.session.phase === 'parsing') env.store.session = { phase: 'idle' };
  const s = () => env.store.session;

  let destroyed = false;
  let parseController = null;
  let diffController = null;
  let dragDepth = 0;
  let view = null; // review helpers: { updatePreview, renderDiff, renderCommit, syncModes }

  const header = pageHeader({
    title: 'Importar catálogo',
    subtitle: 'Carga el listado de utillaje desde un PDF o un CSV. Podrás revisarlo antes de aplicar ningún cambio.',
  });
  const content = h('div.adm-import');
  const fileInput = h('input.sr-only', {
    type: 'file',
    accept: ACCEPT,
    tabIndex: -1,
    'aria-hidden': 'true',
    onChange: () => {
      const file = fileInput.files?.[0];
      fileInput.value = ''; // choosing the same file again must fire "change"
      if (file) void handleFile(file);
    },
  });
  root.append(header.el, content, fileInput);

  const diffSoon = debounce(() => void runDiff(), DIFF_DELAY_MS);
  const refreshSoon = debounce(() => void runDiff(), REFRESH_DELAY_MS);

  // Drops anywhere on the page (and never let the browser open the file instead).
  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (event) => {
    if (!hasFiles(event)) return;
    dragDepth += 1;
    root.querySelector('.dropzone')?.classList.add('is-over');
  };
  const onDragLeave = (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) root.querySelector('.dropzone')?.classList.remove('is-over');
  };
  const onDragOver = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canAcceptFile() ? 'copy' : 'none';
  };
  const onDrop = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    root.querySelector('.dropzone')?.classList.remove('is-over');
    const files = Array.from(event.dataTransfer.files ?? []);
    if (!files.length) return;
    if (!canAcceptFile()) {
      ui.toast('Termina o cancela la revisión actual antes de analizar otro archivo.', { type: 'warning' });
      return;
    }
    if (files.length > 1) ui.toast('Solo se importa un archivo cada vez: se usará el primero.', { type: 'info' });
    void handleFile(files[0]);
  };
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onDrop);

  render();
  if (s().phase === 'review') void runDiff(); // the catalogue may have changed meanwhile

  function canAcceptFile() {
    return s().phase === 'idle' || s().phase === 'done';
  }

  function openPicker() {
    fileInput.click();
  }

  function reset() {
    parseController?.abort();
    diffController?.abort();
    diffSoon.cancel();
    refreshSoon.cancel();
    env.store.session = { phase: 'idle' };
    render({ focus: true });
  }

  // Rendering -------------------------------------------------------------------------

  function render({ focus = false } = {}) {
    if (destroyed) return;
    view = null;
    const session = s();
    switch (session.phase) {
      case 'parsing':
        replace(content, parsingView(session));
        break;
      case 'review':
        replace(content, ...reviewView(session));
        break;
      case 'done':
        replace(content, doneView(session));
        break;
      default:
        replace(content, ...idleView(session));
    }
    if (focus) {
      window.scrollTo({ top: 0, left: 0 });
      (session.phase === 'done' ? content.querySelector('#adm-import-done') : header.title)?.focus({ preventScroll: true });
    }
  }

  // Step 1: choose a file -------------------------------------------------------------

  function idleView(session) {
    const error = session.error
      ? h(
          'div.alert.alert-danger.adm-import-error',
          { role: 'alert' },
          icon('alert-circle'),
          h(
            'div.alert-body',
            h('div.alert-title', session.error.title),
            session.error.file ? h('div.adm-error-file', icon('file', { size: 14 }), session.error.file) : null,
            h('div.alert-text', session.error.text),
            session.error.tips?.length ? h('ul.adm-tips', session.error.tips.map((tip) => h('li', tip))) : null,
          ),
        )
      : null;

    const zone = h(
      'div.dropzone.adm-dropzone',
      {
        onClick: (event) => {
          if (!event.target.closest('button')) openPicker();
        },
      },
      h('div.dropzone-icon', icon('upload', { size: 26 })),
      h('div.dropzone-title', 'Arrastra aquí el archivo PDF o CSV'),
      h('div.dropzone-hint', 'o'),
      button({ label: 'Seleccionar archivo', icon: 'file', variant: 'primary', onClick: openPicker }),
      h('div.dropzone-hint.adm-dropzone-limits', 'PDF con texto seleccionable (hasta 30 MB) o CSV separado por punto y coma, coma o tabulador (hasta 10 MB).'),
    );

    const help = card({
      title: 'Cómo debe ser el listado',
      body: h(
        'div.stack',
        h('p.small.muted', 'Una fila por útil con su código, su ubicación y una descripción. El orden de las columnas da igual y puede haber columnas de más: después podrás indicar qué contiene cada una.'),
        h(
          'div.table-wrap.adm-example',
          h(
            'table.table.table-compact',
            h('caption.sr-only', 'Ejemplo de listado'),
            h('thead', h('tr', h('th', 'Código útil'), h('th', 'Ubicación'), h('th', 'Comentario'))),
            h(
              'tbody',
              h('tr', h('td.cell-code', 'UT-0012'), h('td', 'ARM-01 / E3'), h('td', 'Galga de roscas M8')),
              h('tr', h('td.cell-code', 'CAL-009'), h('td', 'Metrología / B4'), h('td', 'Pie de rey digital 0-300 mm')),
            ),
          ),
        ),
        h(
          'ul.adm-bullets.small.muted',
          h('li', 'Si la primera fila tiene títulos (Código, Ubicación, Descripción…) se reconocen solos.'),
          h('li', 'Los códigos que ya existen se actualizan; no se crean duplicados.'),
          h('li', h('strong', 'No se modifica nada'), ' hasta que revises los cambios y confirmes la importación.'),
        ),
      ),
    });

    return [error, zone, h('div.adm-section', help)];
  }

  async function handleFile(file) {
    if (destroyed || !canAcceptFile()) return;
    const check = await inspectFile(file);
    if (destroyed) return;
    if (check.error) {
      env.store.session = { phase: 'idle', error: check.error };
      render();
      return;
    }
    const info = { name: file.name || 'archivo', size: file.size, kind: check.kind };
    env.store.session = { phase: 'parsing', file: info };
    render();

    parseController?.abort();
    const mine = new AbortController();
    parseController = mine;
    try {
      const parse = await adminRequest('POST', '/admin/import/parse', {
        body: file,
        raw: true,
        headers: { 'Content-Type': check.contentType, 'X-Filename': encodeURIComponent(info.name) },
        signal: mine.signal,
        timeout: PARSE_TIMEOUT_MS,
      });
      if (destroyed || parseController !== mine) return;
      const rows = Array.isArray(parse?.rows) ? parse.rows : [];
      if (rows.length === 0) {
        env.store.session = { phase: 'idle', error: describeParseError({ code: 'EMPTY', message: 'El archivo no contiene filas.' }, info.name) };
        render();
        return;
      }
      const normalized = { ...parse, rows, warnings: Array.isArray(parse.warnings) ? parse.warnings : [] };
      env.store.session = {
        phase: 'review',
        file: info,
        parse: normalized,
        roles: rolesFromMapping(normalized),
        mode: 'merge',
        diff: null,
        diffError: null,
        diffPending: false,
      };
      render({ focus: true });
      void runDiff();
    } catch (err) {
      if (destroyed || parseController !== mine) return;
      if (err.code === 'ABORTED' || err.status === 401) {
        env.store.session = { phase: 'idle' };
        if (err.code === 'ABORTED') render();
        return;
      }
      env.store.session = { phase: 'idle', error: { ...describeParseError(err, info.name), file: info.name } };
      render();
    } finally {
      if (parseController === mine) parseController = null;
    }
  }

  function parsingView(session) {
    const { file } = session;
    return card({
      className: 'adm-parsing',
      body: h(
        'div.stack',
        h(
          'div.adm-file',
          h('span.adm-file-icon', icon('file-text', { size: 20 })),
          h('div.grow', h('div.adm-file-name', file.name), h('div.small.subtle', `${file.kind === 'pdf' ? 'PDF' : 'CSV'} · ${formatBytes(file.size)}`)),
          button({ label: 'Cancelar', variant: 'ghost', size: 'sm', onClick: () => reset() }),
        ),
        h('div.progress.is-indeterminate', { role: 'progressbar', 'aria-label': 'Analizando el archivo' }, h('div.progress-bar')),
        h(
          'p.small.muted',
          { role: 'status' },
          file.kind === 'pdf' ? 'Leyendo las páginas del PDF y reconstruyendo la tabla…' : 'Leyendo el CSV…',
        ),
      ),
    });
  }

  // Step 2: review -------------------------------------------------------------------------

  function reviewView(session) {
    const { parse, file } = session;
    const total = parse.rows.length;
    // The missing header is already explained by its own notice.
    const heuristic = parse.mappingSource === 'heuristic';
    const warnings = heuristic ? parse.warnings.filter((w) => w.type !== 'no_header') : parse.warnings;

    // Summary ------------------------------------------------------------------
    const facts = [
      parse.source === 'pdf' && parse.pages ? ['Páginas', fmt.number(parse.pages)] : null,
      ['Filas detectadas', fmt.number(total)],
      ['Columnas', fmt.number(session.roles.length)],
      ['Avisos', fmt.number(warnings.length)],
    ].filter(Boolean);
    const summary = card({
      className: 'adm-import-summary',
      body: h(
        'div.stack',
        h(
          'div.adm-file',
          h('span.adm-file-icon', icon('file-text', { size: 20 })),
          h(
            'div.grow',
            h('div.adm-file-name', { title: file.name }, file.name),
            h('div.small.subtle', `${parse.source === 'csv' ? 'CSV' : 'PDF'} · ${formatBytes(file.size)}`),
          ),
          button({ label: 'Cambiar archivo', ariaLabel: 'Cambiar archivo', title: 'Cambiar archivo', icon: 'upload', size: 'sm', className: 'adm-change-file', onClick: () => reset() }),
        ),
        h('dl.adm-facts', facts.map(([label, value]) => h('div.adm-fact', h('dt', label), h('dd', value)))),
        heuristic
          ? alertBox({
              type: 'info',
              title: 'No se ha encontrado una fila de títulos',
              text: 'Las columnas se han asignado según su contenido. Revisa la vista previa y corrígelas si hace falta.',
            })
          : null,
        warnings.length ? warningList(warnings) : null,
      ),
    });

    // Preview + column roles --------------------------------------------------------
    const mappingNote = h('div.adm-mapping-note');
    const selects = [];
    const headCells = [];
    const previewRows = parse.rows.slice(0, PREVIEW_ROWS);
    const roleOptions = ROLE_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
    const headRow = h(
      'tr',
      h('th.num.adm-rownum', { scope: 'col' }, h('span.sr-only', 'Fila'), '#'),
      session.roles.map((role, index) => {
        const name = columnName(parse, index);
        const control = select({
          options: roleOptions,
          value: role,
          size: 'sm',
          attrs: { 'aria-label': `Contenido de «${name}»` },
          onChange: () => setRole(index, control.value),
        });
        selects.push(control);
        const th = h('th', { scope: 'col', dataset: { col: index } }, h('div.adm-col-head', h('span.adm-col-name', { title: name }, name), control));
        headCells.push(th);
        return th;
      }),
    );
    const body = h(
      'tbody',
      previewRows.map((row, rowIndex) =>
        h(
          'tr',
          h('td.num.adm-rownum', { title: row?.page ? `Página ${row.page}` : null }, fmt.number(rowIndex + 1)),
          session.roles.map((_, index) => h('td', { dataset: { col: index } }, String(row?.cells?.[index] ?? ''))),
        ),
      ),
    );
    const table = h('table.table.table-compact.adm-preview-table', h('caption.sr-only', 'Vista previa del archivo'), h('thead', headRow), body);
    const preview = card({
      title: 'Columnas y vista previa',
      subtitle:
        total > PREVIEW_ROWS
          ? `Primeras ${PREVIEW_ROWS} de ${fmt.number(total)} filas. Indica qué contiene cada columna.`
          : `${fmt.count(total, 'fila', 'filas')}. Indica qué contiene cada columna.`,
      padded: false,
      className: 'adm-preview-card',
      body: h('div', mappingNote, h('div.table-wrap.is-scroll.adm-preview', { tabIndex: 0, 'aria-label': 'Vista previa (desplazable)' }, table)),
    });

    function updatePreview() {
      const roles = s().roles;
      roles.forEach((role, index) => {
        if (selects[index].value !== role) selects[index].value = role;
        headCells[index].dataset.role = role;
      });
      for (const cell of body.querySelectorAll('td[data-col]')) cell.dataset.role = roles[Number(cell.dataset.col)];
      const hasCode = roles.includes('code');
      const missing = ['location', 'description'].filter((role) => !roles.includes(role));
      let note = null;
      if (!hasCode) {
        note = alertBox({
          type: 'danger',
          title: 'Falta la columna Código',
          text: 'Elige «Código» en la columna que contiene el código de cada útil. Sin ella no se puede importar.',
        });
      } else if (missing.length) {
        // Not blocking, but an import without them empties that data in existing tools.
        const both = missing.length === 2;
        note = alertBox({
          type: 'warning',
          title: both
            ? 'No hay columnas de Ubicación ni de Descripción'
            : `No hay columna de ${missing[0] === 'location' ? 'Ubicación' : 'Descripción'}`,
          text: both
            ? 'Los útiles se importarán sin esos datos y los que ya existen los perderán. Asígnalas si el archivo las tiene.'
            : 'Los útiles se importarán sin ese dato y los que ya existen lo perderán. Asígnala si el archivo la tiene.',
        });
      }
      replace(mappingNote, note ?? '');
      mappingNote.hidden = !note;
    }

    // Differences ------------------------------------------------------------------------
    const diffBody = h('div.adm-diff');
    const diffCard = card({
      title: 'Cambios en el catálogo',
      subtitle: 'Comparación del archivo con los útiles que ya hay en Nevko.',
      body: diffBody,
      className: 'adm-diff-card',
    });

    // Mode ----------------------------------------------------------------------------------
    const modeWarning = h('div');
    const modeChoice = (value, title, text, extra) => {
      const radio = h('input', {
        type: 'radio',
        name: 'adm-import-mode',
        value,
        checked: s().mode === value,
        onChange: () => {
          if (!radio.checked) return;
          s().mode = value;
          syncModes();
          renderDiff();
          renderCommit();
        },
      });
      return h(
        'label.choice.adm-mode',
        { dataset: { mode: value } },
        radio,
        h('span.adm-choice-text', h('span.adm-choice-title', title, extra), h('span.adm-choice-desc', text)),
      );
    };
    const modes = h(
      'div.adm-modes',
      { role: 'radiogroup', 'aria-label': 'Modo de importación' },
      modeChoice(
        'merge',
        'Actualizar y añadir',
        'Añade los útiles nuevos y actualiza los que ya existen. Los útiles que no aparecen en el archivo se conservan tal como están.',
        tag('Recomendado', 'primary'),
      ),
      modeChoice(
        'replace',
        'Sustituir el catálogo completo',
        'Además, da de baja los útiles que no aparecen en el archivo. No se borran: se conservan en el historial y se pueden reactivar.',
      ),
    );
    const modeCard = card({ title: 'Modo de importación', body: h('div.stack', modes, modeWarning) });

    function syncModes() {
      const mode = s().mode;
      for (const label of modes.querySelectorAll('.adm-mode')) label.classList.toggle('is-selected', label.dataset.mode === mode);
      const diff = s().diff;
      const missing = diff?.counts?.missing ?? 0;
      const missingInUse = diff?.counts?.missingInUse ?? 0;
      replace(
        modeWarning,
        mode === 'replace' && missing > 0
          ? alertBox({
              type: 'warning',
              title: plural(missing, 'Se dará de baja 1 útil', (n) => `Se darán de baja ${n} útiles`),
              text:
                missingInUse > 0
                  ? plural(
                      missingInUse,
                      'Uno de ellos está en uso: seguirá a nombre de su operario hasta que se devuelva.',
                      (n) => `De ellos, ${n} están en uso: seguirán a nombre de su operario hasta que se devuelvan.`,
                    )
                  : 'Dejarán de aparecer en la búsqueda de los operarios.',
            })
          : '',
      );
    }

    // Commit bar ------------------------------------------------------------------------------
    const commitInfo = h('div.adm-commit-info', { 'aria-live': 'polite' });
    const commitButton = button({ label: 'Importar', icon: 'check', variant: 'primary', onClick: () => void commit() });
    const commitBar = h(
      'div.adm-commit-bar',
      commitInfo,
      h('div.adm-commit-actions', button({ label: 'Cancelar', variant: 'ghost', className: 'adm-commit-cancel', onClick: () => void cancelReview() }), commitButton),
    );

    function renderCommit() {
      const session = s();
      const hasCode = session.roles.includes('code');
      const count = validCount(session.diff);
      const ready = hasCode && session.diff && !session.diffPending && count > 0 && !session.committing;
      if (!session.committing) commitButton.disabled = !ready;
      commitButton.querySelector('.btn-label').textContent = session.diff && hasCode ? `Importar ${fmt.tools(count)}` : 'Importar';
      let text;
      if (!hasCode) text = 'Asigna la columna Código para continuar.';
      else if (session.diffPending || (!session.diff && !session.diffError)) text = 'Comparando con el catálogo…';
      else if (session.diffError && !session.diff) text = 'No se han podido calcular los cambios.';
      else if (count === 0) text = 'No hay ninguna fila válida para importar.';
      else {
        const erased = erasedFields(session);
        text = `${IMPORT_MODE_LABELS[session.mode]} · ${changeSummary(session.diff, session.mode)}`;
        if (erased.length) text += ` · ${erased.map((item) => `se borrará ${FIELD_NAMES[item.role]} de ${exactCount(item)}`).join(' y ')}`;
      }
      commitInfo.textContent = text;
      commitInfo.classList.toggle('is-danger', Boolean(session.diff && hasCode && erasedFields(session).length));
    }

    function renderDiff() {
      replace(diffBody, diffContent(s()));
      diffBody.classList.toggle('is-busy', Boolean(s().diffPending && s().diff));
      syncModes();
    }

    /** Busy state while the import is being applied (every control that changes the review is locked). */
    function setCommitting(busy) {
      ui.setBusy(commitButton, busy);
      for (const control of [...content.querySelectorAll('select, input[type=radio], .adm-change-file, .adm-commit-cancel')]) control.disabled = busy;
    }

    view = { updatePreview, renderDiff, renderCommit, syncModes, setCommitting };
    updatePreview();
    renderDiff();
    renderCommit();

    return [summary, h('div.adm-section', preview), h('div.adm-section', diffCard), h('div.adm-section', modeCard), commitBar];
  }

  function warningList(warnings) {
    const items = warnings.slice(0, MAX_LISTED_ISSUES).map((warning) =>
      h(
        'li.adm-issue',
        tag(WARNING_LABELS[warning.type] ?? 'Aviso', warning.type === 'no_header' ? 'primary' : 'warning'),
        h('span.adm-issue-text', warning.message || ''),
        warning.page ? h('span.adm-issue-meta', `pág. ${warning.page}`) : null,
      ),
    );
    return h(
      'details.adm-disclosure',
      { open: warnings.length <= 3 },
      h('summary', icon('alert-triangle', { size: 16 }), `Avisos de lectura (${fmt.number(warnings.length)})`),
      h(
        'div.adm-disclosure-body',
        h('p.small.subtle', 'Líneas que no parecían parte de la tabla o que se han corregido al leer el archivo. Revisa la vista previa si alguno te preocupa.'),
        h('ul.adm-issues', items),
      ),
    );
  }

  function setRole(column, role) {
    const roles = s().roles;
    const previous = roles[column];
    if (previous === role) return;
    if (role !== 'ignore') {
      // A role belongs to one column: the column that had it takes this column's old role.
      const other = roles.indexOf(role);
      if (other >= 0 && other !== column) roles[other] = previous;
    }
    roles[column] = role;
    s().diff = null;
    s().diffError = null;
    view?.updatePreview();
    view?.renderDiff();
    view?.renderCommit();
    diffSoon();
  }

  async function runDiff() {
    const session = s();
    if (destroyed || session.phase !== 'review' || session.committing) return;
    diffController?.abort();
    if (!session.roles.includes('code')) {
      session.diff = null;
      session.diffPending = false;
      view?.renderDiff();
      view?.renderCommit();
      return;
    }
    const mine = new AbortController();
    diffController = mine;
    session.diffPending = true;
    view?.renderDiff();
    view?.renderCommit();
    try {
      const diff = await adminRequest('POST', '/admin/import/diff', {
        body: { rows: buildRows(session.parse, session.roles) },
        signal: mine.signal,
        timeout: DIFF_TIMEOUT_MS,
      });
      if (destroyed || diffController !== mine || s() !== session) return;
      session.diff = diff;
      session.diffError = null;
    } catch (err) {
      if (destroyed || diffController !== mine || s() !== session || err.code === 'ABORTED' || err.status === 401) return;
      session.diffError = err;
    }
    session.diffPending = false;
    diffController = null;
    view?.renderDiff();
    view?.renderCommit();
  }

  function exactCount({ count, exact }) {
    return exact ? fmt.tools(count) : `hasta ${fmt.tools(count)}`;
  }

  function changeSummary(diff, mode) {
    const c = diff.counts;
    const parts = [];
    if (c.new) parts.push(`${fmt.number(c.new)} ${c.new === 1 ? 'nuevo' : 'nuevos'}`);
    if (c.updated) parts.push(`${fmt.number(c.updated)} ${c.updated === 1 ? 'modificado' : 'modificados'}`);
    if (mode === 'replace' && c.missing) parts.push(`${fmt.number(c.missing)} de baja`);
    return parts.length ? parts.join(', ') : 'sin cambios en el catálogo';
  }

  function diffContent(session) {
    if (!session.roles.includes('code')) {
      return h('p.small.subtle', 'Asigna la columna Código para ver los cambios.');
    }
    if (!session.diff) {
      if (session.diffError) return inlineError(session.diffError, () => void runDiff(), 'No se han podido calcular los cambios');
      return h('div.loading-block.adm-diff-loading', spinner({ size: 'lg', label: 'Comparando' }), h('span', 'Comparando con el catálogo…'));
    }
    const { counts = {}, changes = [], multiUnit = [], invalid = [], truncated = [], similar = [] } = session.diff;
    const isReplace = session.mode === 'replace';
    const updatedHint = [
      counts.renamed ? plural(counts.renamed, '1 renombrado', (n) => `${n} renombrados`) : null,
      counts.reactivated ? plural(counts.reactivated, '1 se reactiva', (n) => `${n} se reactivan`) : null,
    ].filter(Boolean);
    const stat = (label, value, tone, hint) =>
      h(
        'div.adm-stat',
        { class: value ? `is-${tone}` : 'is-zero' },
        h('div.adm-stat-value', fmt.number(value ?? 0)),
        h('div.adm-stat-label', label),
        hint ? h('div.adm-stat-hint', hint) : null,
      );
    const stats = h(
      'div.adm-stats',
      stat('Nuevos', counts.new, 'success', 'Se añadirán'),
      stat('Modificados', counts.updated, 'primary', updatedHint.length ? updatedHint.join(' · ') : 'Se actualizarán'),
      stat('Sin cambios', counts.unchanged, 'neutral', 'Ya están al día'),
      stat(
        'No incluidos',
        counts.missing,
        isReplace ? 'danger' : 'neutral',
        [isReplace ? 'Se darán de baja' : 'Se conservan', counts.missingInUse ? `${fmt.number(counts.missingInUse)} en uso` : null]
          .filter(Boolean)
          .join(' · '),
      ),
      stat('Varias unidades', counts.multiUnit, 'primary', 'Códigos con varias filas: una por unidad'),
      stat('No válidos', counts.invalid, 'danger', 'Se ignoran'),
    );

    const sections = [stats];
    const erased = erasedFields(session);
    if (erased.length) {
      sections.push(
        alertBox({
          type: 'danger',
          title: erased.length === 2 ? 'Se borrarán datos de útiles que ya existen' : `Se borrará ${FIELD_NAMES[erased[0].role]} de útiles que ya existen`,
          text: `${erased.map(erasedSentence).join(' ')} Si el archivo tiene esa columna, asígnala en la vista previa.`,
        }),
      );
    }
    if (similar.length) sections.push(similarNotice(similar));
    if (changes.length) sections.push(changesDisclosure(session, changes));
    if (multiUnit.length) {
      sections.push(
        h(
          'details.adm-disclosure',
          h('summary', icon('copy', { size: 16 }), `Códigos con varias unidades (${fmt.number(multiUnit.length)})`),
          h(
            'div.adm-disclosure-body',
            h(
              'p.small.subtle',
              'Aparecen en varias filas: cada fila es una unidad del útil, con su propia ubicación, su estado y su historial.',
            ),
            h(
              'ul.adm-code-list',
              multiUnit.slice(0, MAX_LISTED_ISSUES).map((item) =>
                h('li.adm-code-chip', item.code, h('span.adm-chip-count', ` × ${fmt.number(item.count)}`)),
              ),
            ),
            multiUnit.length > MAX_LISTED_ISSUES ? h('p.small.subtle', `Se muestran los primeros ${MAX_LISTED_ISSUES}.`) : null,
          ),
        ),
      );
    }
    if (truncated.length) {
      sections.push(
        h(
          'details.adm-disclosure',
          h('summary', icon('alert-triangle', { size: 16 }), `Textos que se recortarán (${fmt.number(truncated.length)})`),
          h(
            'div.adm-disclosure-body',
            h('p.small.subtle', 'Superan la longitud máxima y se importarán recortados. Si falta algo importante, acórtalos en el archivo.'),
            h(
              'ul.adm-issues',
              truncated.slice(0, MAX_LISTED_ISSUES).map((item) =>
                h(
                  'li.adm-issue',
                  h('span.adm-issue-meta.nowrap', rowLabel(session.parse, item.index)),
                  item.code ? h('span.adm-code.small', item.code) : null,
                  h('span.adm-issue-text', truncatedText(item)),
                ),
              ),
            ),
            truncated.length > MAX_LISTED_ISSUES ? h('p.small.subtle', `Se muestran las primeras ${MAX_LISTED_ISSUES}.`) : null,
          ),
        ),
      );
    }
    if (invalid.length) {
      sections.push(
        h(
          'details.adm-disclosure',
          h('summary', icon('alert-circle', { size: 16 }), `Filas que no se importarán (${fmt.number(invalid.length)})`),
          h(
            'div.adm-disclosure-body',
            h(
              'ul.adm-issues',
              invalid.slice(0, MAX_LISTED_ISSUES).map((item) =>
                h(
                  'li.adm-issue',
                  h('span.adm-issue-meta.nowrap', rowLabel(session.parse, item.index)),
                  h('span.adm-issue-text', item.reason || 'Fila no válida.'),
                  item.code ? h('span.adm-code.small', item.code) : null,
                ),
              ),
            ),
            invalid.length > MAX_LISTED_ISSUES
              ? h('p.small.subtle', `Se muestran las primeras ${MAX_LISTED_ISSUES}.`)
              : null,
          ),
        ),
      );
    }
    return h('div.stack', sections);
  }

  /** Codes of the file that are the same code written differently: imported as separate tools. */
  function similarNotice(similar) {
    return h(
      'details.adm-disclosure.is-warning',
      { open: similar.length <= 3 },
      h('summary', icon('alert-triangle', { size: 16 }), `Códigos que parecen repetidos (${fmt.number(similar.length)})`),
      h(
        'div.adm-disclosure-body',
        h(
          'p.small.subtle',
          'Son el mismo código escrito de formas distintas y se importarían como útiles diferentes. Si son el mismo útil, déjalo escrito de una sola forma en el archivo.',
        ),
        h(
          'ul.adm-similar',
          similar.slice(0, MAX_LISTED_ISSUES).map((codes) => h('li.adm-code-list', codes.map((code) => h('span.adm-code-chip', code)))),
        ),
      ),
    );
  }

  /** Changes that the import applies: new + updated (+ missing ones in replace mode). */
  function realChangeCount(session) {
    const c = session.diff?.counts ?? {};
    return (c.new ?? 0) + (c.updated ?? 0) + (session.mode === 'replace' ? c.missing ?? 0 : 0);
  }

  function changesDisclosure(session, changes) {
    const real = realChangeCount(session);
    const missing = session.diff?.counts?.missing ?? 0;
    const summaryText =
      real > 0
        ? `Ver la lista de cambios (${fmt.number(real)})`
        : `Útiles que no están en el archivo (${fmt.number(missing)})`;
    const details = h(
      'details.adm-disclosure',
      { open: Boolean(session.changesOpen) },
      h('summary', icon('list', { size: 16 }), summaryText),
    );
    const bodyEl = h('div.adm-disclosure-body');
    details.append(bodyEl);
    let rendered = false;
    const fill = () => {
      if (rendered) return;
      rendered = true;
      bodyEl.append(changeGroups(session, changes));
    };
    details.addEventListener('toggle', () => {
      session.changesOpen = details.open;
      if (details.open) fill();
    });
    if (details.open) fill();
    return details;
  }

  function changeGroups(session, changes) {
    const isReplace = session.mode === 'replace';
    const counts = session.diff?.counts ?? {};
    const groups = [
      ['new', 'Nuevos', counts.new],
      ['renamed', 'Renombrados', counts.renamed, 'El mismo útil con el código escrito de otra forma: conserva su historial y pasa a escribirse como en el archivo.'],
      ['updated', 'Modificados', (counts.updated ?? 0) - (counts.renamed ?? 0)],
      ['missing', isReplace ? 'No incluidos: se darán de baja' : 'No incluidos: se conservan', counts.missing],
    ];
    const fieldLabels = { code: 'Código', location: 'Ubicación', description: 'Descripción' };
    const text = (value) => (value ? value : h('span.subtle', '(vacío)'));

    const item = (change) => {
      const lines = [];
      if (change.kind === 'new') {
        lines.push(h('div.adm-change-detail', text(change.after?.location), change.after?.description ? ` · ${change.after.description}` : null));
      } else if (change.kind === 'updated' || change.kind === 'renamed') {
        for (const key of ['code', 'location', 'description']) {
          const before = change.before?.[key] ?? '';
          const after = change.after?.[key] ?? '';
          if (before === after) continue;
          lines.push(
            h(
              'div.adm-change-field',
              h('span.adm-change-label', fieldLabels[key]),
              h('del.adm-before', text(before)),
              h('span.adm-arrow', { 'aria-label': 'pasa a' }, icon('arrow-right', { size: 14 })),
              h('ins.adm-after', text(after)),
            ),
          );
        }
        if (!lines.length && change.reactivate) lines.push(h('div.adm-change-detail', 'Sin cambios en los datos.'));
      } else {
        lines.push(h('div.adm-change-detail', text(change.before?.location), change.before?.description ? ` · ${change.before.description}` : null));
      }
      return h(
        'li.adm-change',
        h(
          'div.adm-change-head',
          h('span.adm-code', change.code),
          unitTag({ unitIndex: change.unit, unitCount: change.units }),
          change.reactivate ? tag('Se reactiva', 'success') : null,
          change.kind === 'missing' && change.inUse ? tag('En uso', 'warning') : null,
        ),
        lines,
      );
    };

    const fragments = groups.map(([kind, title, total, note]) => {
      const list = changes.filter((change) => change.kind === kind);
      if (!list.length) return null;
      const count = Math.max(list.length, Number(total) || 0);
      const content = [
        note ? h('p.small.subtle.adm-change-note', note) : null,
        h('ul.adm-changes', list.map(item)),
        count > list.length ? h('p.small.subtle', `Se muestran los primeros ${fmt.number(list.length)} de ${fmt.number(count)}.`) : null,
      ];
      if (kind === 'missing' && !isReplace) {
        // Merge mode keeps them as they are: listed apart, collapsed, so the real changes stand out.
        return h(
          'details.adm-disclosure.adm-kept',
          { open: realChangeCount(session) === 0 },
          h('summary', `${title} (${fmt.number(count)})`),
          h('div.adm-disclosure-body', content),
        );
      }
      return h('section.adm-change-group', h('h3.adm-change-title', `${title} (${fmt.number(count)})`), content);
    });
    return h('div.stack', fragments);
  }

  async function cancelReview() {
    const confirmed = await ui.confirm({
      title: '¿Descartar esta importación?',
      message: 'No se ha cambiado nada en el catálogo. Podrás volver a subir el archivo cuando quieras.',
      confirmLabel: 'Descartar',
    });
    if (confirmed) reset();
  }

  // Step 3: commit ------------------------------------------------------------------------------

  async function commit() {
    const session = s();
    const diff = session.diff;
    if (!diff || !session.roles.includes('code') || session.diffPending) return;
    const count = validCount(diff);
    if (count === 0) return;
    const c = diff.counts;
    const isReplace = session.mode === 'replace';
    const updatedNotes = [
      c.renamed ? plural(c.renamed, '1 con el código escrito de otra forma', (n) => `${n} con el código escrito de otra forma`) : null,
      c.reactivated ? plural(c.reactivated, '1 se reactiva', (n) => `${n} se reactivan`) : null,
    ].filter(Boolean);
    const erased = erasedFields(session);
    const lines = [
      c.new ? plural(c.new, 'Se añadirá 1 útil nuevo.', (n) => `Se añadirán ${n} útiles nuevos.`) : null,
      c.updated
        ? `${plural(c.updated, 'Se actualizará 1 útil', (n) => `Se actualizarán ${n} útiles`)}${updatedNotes.length ? ` (${updatedNotes.join('; ')})` : ''}.`
        : null,
      c.unchanged ? plural(c.unchanged, '1 útil no cambia.', (n) => `${n} útiles no cambian.`) : null,
      c.missing
        ? isReplace
          ? plural(c.missing, 'Se dará de baja 1 útil que no está en el archivo.', (n) => `Se darán de baja ${n} útiles que no están en el archivo.`)
          : plural(c.missing, '1 útil que no está en el archivo se conserva.', (n) => `${n} útiles que no están en el archivo se conservan.`)
        : null,
      c.multiUnit
        ? plural(
            c.multiUnit,
            '1 código tiene varias filas: cada fila es una unidad del útil.',
            (n) => `${n} códigos tienen varias filas: cada fila es una unidad del útil.`,
          )
        : null,
      c.invalid ? plural(c.invalid, 'Se ignora 1 fila no válida.', (n) => `Se ignoran ${n} filas no válidas.`) : null,
      c.truncated
        ? plural(c.truncated, 'En 1 fila se recorta un texto demasiado largo.', (n) => `En ${n} filas se recorta un texto demasiado largo.`)
        : null,
    ].filter(Boolean);

    const confirmed = await ui.confirm({
      title: isReplace ? '¿Sustituir el catálogo?' : '¿Importar el catálogo?',
      message: h(
        'div.stack.stack-sm',
        h('ul.adm-confirm-list', lines.map((line) => h('li', line))),
        erased.length
          ? alertBox({
              type: 'danger',
              title: erased.length === 2 ? 'Sin columnas de Ubicación ni de Descripción' : `Sin columna de ${erased[0].role === 'location' ? 'Ubicación' : 'Descripción'}`,
              text: `${erased.map(erasedSentence).join(' ')} Si el archivo tiene esa columna, cancela y asígnala en la vista previa.`,
            })
          : null,
        c.similar
          ? alertBox({
              type: 'warning',
              text: plural(
                c.similar,
                'Hay 1 código escrito de dos formas en el archivo: se importará como útiles distintos.',
                (n) => `Hay ${n} códigos escritos de varias formas en el archivo: se importarán como útiles distintos.`,
              ),
            })
          : null,
        isReplace && c.missingInUse
          ? alertBox({
              type: 'warning',
              text: plural(
                c.missingInUse,
                '1 de los útiles que se dan de baja está en uso y seguirá a nombre de su operario.',
                (n) => `${n} de los útiles que se dan de baja están en uso y seguirán a nombre de su operario.`,
              ),
            })
          : null,
      ),
      confirmLabel: `Importar ${fmt.tools(count)}`,
      danger: (isReplace && c.missing > 0) || erased.length > 0,
      icon: 'upload',
    });
    if (!confirmed || destroyed || s() !== session || session.committing) return;

    // The request runs outside the dialog, so closing it (Esc, back button) cannot hide
    // an import that is already on its way.
    session.committing = true;
    refreshSoon.cancel();
    diffSoon.cancel();
    view?.setCommitting(true);
    let result;
    try {
      result = await adminRequest('POST', '/admin/import/commit', {
        body: { rows: buildRows(session.parse, session.roles), mode: session.mode, filename: session.file?.name ?? null },
        timeout: COMMIT_TIMEOUT_MS,
      });
    } catch (err) {
      session.committing = false;
      if (s() !== session || destroyed) return;
      view?.setCommitting(false);
      if (err.status !== 401) reportError(err, 'No se ha podido importar el catálogo.');
      view?.renderCommit();
      void runDiff();
      return;
    }
    session.committing = false;
    if (s() !== session) return;
    // Kept even if the admin left the page meanwhile: the result is shown on return.
    env.store.session = { phase: 'done', file: session.file, mode: session.mode, result };
    if (!destroyed) render({ focus: true });
  }

  function doneView(session) {
    const r = session.result ?? {};
    const stat = (label, value, tone) =>
      h('div.adm-stat', { class: value ? `is-${tone}` : 'is-zero' }, h('div.adm-stat-value', fmt.number(value ?? 0)), h('div.adm-stat-label', label));
    return h(
      'section.card.adm-done',
      { 'aria-labelledby': 'adm-import-done' },
      h('div.adm-done-icon', icon('check-circle', { size: 30 })),
      h('h1.adm-done-title#adm-import-done', { tabIndex: -1 }, 'Catálogo importado'),
      h('p.adm-done-text', `${session.file?.name ?? 'Archivo'} · ${IMPORT_MODE_LABELS[session.mode] ?? ''}`),
      h(
        'div.adm-stats.adm-done-stats',
        stat('Añadidos', r.inserted, 'success'),
        stat('Actualizados', r.updated, 'primary'),
        stat('Reactivados', r.reactivated, 'primary'),
        r.renamed ? stat('Renombrados', r.renamed, 'primary') : null,
        stat('Sin cambios', r.unchanged, 'neutral'),
        stat('Dados de baja', r.deactivated, 'warning'),
      ),
      h(
        'div.btn-group.adm-center',
        button({ label: 'Ir a Útiles', iconRight: 'arrow-right', variant: 'primary', onClick: () => env.go('utiles', { q: '' }) }),
        button({ label: 'Importar otro archivo', icon: 'upload', onClick: () => reset() }),
      ),
    );
  }

  // Lifecycle --------------------------------------------------------------------------------------

  return {
    onChange(event) {
      // The catalogue or the tools in use changed: the differences may be different now.
      if (event.type !== 'operators' && s().phase === 'review' && !s().committing) refreshSoon();
    },
    destroy() {
      destroyed = true;
      diffSoon.cancel();
      refreshSoon.cancel();
      parseController?.abort();
      diffController?.abort();
      // A finished import is not shown again when coming back; an unfinished review is.
      if (s().phase === 'parsing' || s().phase === 'done') env.store.session = { phase: 'idle' };
      if (s().phase === 'review') s().diffPending = false;
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    },
  };
}
