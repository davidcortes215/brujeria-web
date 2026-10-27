// Shared helpers for the administration screens: admin requests, page header,
// responsive tables, pagination, live durations, force-return flow, downloads,
// clipboard and small form controls. Styles live in css/admin.css (prefix "adm-").

import { request } from '../api.js';
import { button, errorState, pill } from '../components.js';
import { h } from '../dom.js';
import * as fmt from '../fmt.js';
import { confirm, liveTime, toast, toastError } from '../ui.js';

export const HOUR_MS = 60 * 60 * 1000;
/** "En uso" durations: amber above 8 h, red above 24 h (SPEC §7). */
export const WARN_AFTER_MS = 8 * HOUR_MS;
export const DANGER_AFTER_MS = 24 * HOUR_MS;

/** Import modes (POST /admin/import/commit). */
export const IMPORT_MODE_LABELS = Object.freeze({
  merge: 'Actualizar y añadir',
  replace: 'Sustituir catálogo',
});

/** Request with the admin token (`tt.adminToken`). Same options as api.request. */
export function adminRequest(method, path, options = {}) {
  return request(method, path, { ...options, admin: true });
}

/** Debounced function with `.cancel()`. */
export function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

/** True when the page is open on the server PC itself (localhost, 127.x, ::1). */
export function isLocalHost(hostname = window.location.hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
}

/** Lock-out waits (429 retryAfter, seconds): '45 s', '1 min', '4 min 30 s', '15 min'. */
export function formatWait(seconds) {
  return fmt.wait(seconds);
}

/**
 * Second-by-second countdown. `onTick(left)` runs now and every second with the seconds
 * left; `onDone()` runs once at 0. Returns a function that stops it.
 */
export function countdown(seconds, onTick, onDone) {
  const deadline = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  let timer = null;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (left <= 0) {
      clearInterval(timer);
      timer = null;
      onDone?.();
      return;
    }
    onTick(left);
  };
  timer = setInterval(tick, 1000);
  tick();
  return () => {
    clearInterval(timer);
    timer = null;
  };
}

/** True for errors that should not be shown (aborted requests, lost admin session). */
export function isSilentError(err) {
  return err?.code === 'ABORTED' || err?.status === 401;
}

/** Toast for an error unless it is silent (aborted / session lost: the login screen explains it). */
export function reportError(err, fallback) {
  if (isSilentError(err)) return;
  toastError(err, fallback);
}

// ---------------------------------------------------------------------------
// Page chrome

/**
 * Page header: <h1> (focus target on navigation), subtitle and trailing actions.
 * @returns {{ el: HTMLElement, title: HTMLElement, setSubtitle(text: string|null): void }}
 */
export function pageHeader({ title, subtitle, actions } = {}) {
  const titleEl = h('h1.admin-page-title', { tabIndex: -1 }, title);
  const subtitleEl = h('p.admin-page-subtitle', { hidden: !subtitle }, subtitle || '');
  const el = h(
    'header.admin-page-header',
    h('div.adm-header-text', titleEl, subtitleEl),
    actions ? h('div.adm-header-actions', actions) : null,
  );
  return {
    el,
    title: titleEl,
    setSubtitle(text) {
      subtitleEl.textContent = text || '';
      subtitleEl.hidden = !text;
    },
  };
}

/** Error block inside a card / table area, with a retry button. */
export function inlineError(err, onRetry, title = 'No se ha podido cargar') {
  return h('div.adm-inline-error', errorState(err, onRetry, { title }));
}

// ---------------------------------------------------------------------------
// Tables

/**
 * Responsive data table: a normal table on wide screens, one card per row on phones
 * (each cell shows its column label, from `data-label`).
 * @param {object} o
 * @param {Array<{label:string, className?:string, primary?:boolean, hideLabel?:boolean,
 *          cell:(row, index)=>any}>} o.columns  `primary`: headline of the phone card (no label)
 * @param {Array} o.rows
 * @param {(row, index)=>object} [o.rowProps] props for each <tr> (class, dataset, onClick...)
 * @param {string} [o.caption] accessible caption
 * @param {Node|string} [o.empty] content of the single row shown when `rows` is empty
 * @param {string|string[]} [o.className]
 */
export function dataTable({ columns, rows, rowProps, caption, empty, className } = {}) {
  const head = h(
    'thead',
    h('tr', columns.map((col) => h('th', { scope: 'col', class: col.className }, col.label || h('span.sr-only', col.srLabel || '')))),
  );
  const body = h('tbody');
  if (rows.length === 0) {
    body.append(h('tr.adm-empty-row', h('td.table-empty', { colSpan: columns.length }, empty ?? 'Sin datos.')));
  } else {
    rows.forEach((row, index) => {
      body.append(
        h(
          'tr',
          rowProps?.(row, index) ?? {},
          columns.map((col) =>
            h(
              'td',
              {
                class: [col.className, col.primary && 'rt-primary'],
                dataset: { label: col.primary || col.hideLabel || !col.label ? undefined : col.label },
              },
              col.cell(row, index),
            ),
          ),
        ),
      );
    });
  }
  return h('table.table.rtable', { class: className }, caption ? h('caption.sr-only', caption) : null, head, body);
}

/** Makes a table row open something on click (ignores clicks on buttons, links and fields). */
export function clickableRow(onOpen) {
  return {
    class: 'is-clickable',
    onClick: (event) => {
      if (event.target.closest('button, a, input, select, textarea, label')) return;
      if (window.getSelection?.().toString()) return; // the user is selecting text
      onOpen(event);
    },
  };
}

/** Skeleton rows for a table that is loading. */
export function tableSkeleton(rows = 6, columns = 4) {
  return h(
    'div.adm-table-skeleton',
    { 'aria-busy': 'true', 'aria-label': 'Cargando' },
    Array.from({ length: rows }, (_, i) =>
      h(
        'div.adm-skeleton-row',
        Array.from({ length: columns }, (_, j) =>
          h('div.skeleton.skeleton-line', { style: { width: `${[70, 55, 80, 45, 60][(i + j) % 5]}%` } }),
        ),
      ),
    ),
  );
}

/**
 * Pagination bar: "1–100 de 1.234" + previous / next.
 * @param {{offset:number, limit:number, total:number, onChange:(offset:number)=>void}} o
 */
export function pagination({ offset, limit, total, onChange }) {
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + limit, total);
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(pages, Math.floor(offset / limit) + 1);
  return h(
    'nav.pagination',
    { 'aria-label': 'Paginación' },
    h('span.adm-range', `${fmt.number(from)}–${fmt.number(to)} de ${fmt.number(total)}`),
    pages > 1
      ? h(
          'div.pagination-controls',
          button({
            icon: 'chevron-left',
            label: 'Anterior',
            ariaLabel: 'Página anterior',
            size: 'sm',
            disabled: page <= 1,
            className: 'adm-page-btn',
            onClick: () => onChange(Math.max(0, offset - limit)),
          }),
          h('span.adm-page-indicator', { 'aria-live': 'polite' }, `Página ${fmt.number(page)} de ${fmt.number(pages)}`),
          button({
            iconRight: 'chevron-right',
            label: 'Siguiente',
            ariaLabel: 'Página siguiente',
            size: 'sm',
            disabled: page >= pages,
            className: 'adm-page-btn',
            onClick: () => onChange(offset + limit),
          }),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Tool status and durations

/** Status pills for the admin: "De baja" and/or "En uso · Nombre", otherwise "Disponible". */
export function toolPills(tool) {
  const pills = [];
  if (tool.active === false) pills.push(pill('inactive', 'De baja'));
  if (tool.holder) {
    pills.push(pill('other', `En uso · ${tool.holder.name}`, { title: `En uso por ${tool.holder.name}` }));
  } else if (tool.active !== false) {
    pills.push(pill('available', 'Disponible'));
  }
  return h('span.adm-pills', pills);
}

/** 'warning' above 8 h, 'danger' above 24 h, otherwise null. */
export function durationTone(ms) {
  if (ms > DANGER_AFTER_MS) return 'danger';
  if (ms > WARN_AFTER_MS) return 'warning';
  return null;
}

/** Elapsed time since `since` ("2 h 16 min"), kept up to date and coloured by duration. */
export function liveDuration(since) {
  const start = fmt.toDate(since)?.getTime() ?? Date.now();
  return liveTime(since, fmt.elapsed, {
    className: 'adm-duration',
    onTick: (el, now) => {
      const tone = durationTone(now.getTime() - start);
      el.classList.toggle('text-warning', tone === 'warning');
      el.classList.toggle('text-danger', tone === 'danger');
      el.classList.toggle('is-long', tone !== null);
    },
  });
}

/** Date and time with the exact timestamp as tooltip: "hoy 08:14". */
export function dateTimeCell(iso) {
  if (!iso) return h('span.subtle', '—');
  return h('time.nowrap', { datetime: iso, title: fmt.absolute(iso) }, fmt.dateTime(iso));
}

// ---------------------------------------------------------------------------
// Force return

/**
 * Asks for confirmation and forces the return of a tool (checkout closed as 'forced').
 * Resolves true when the tool was returned.
 */
export async function forceReturn(tool) {
  const holderName = tool.holder?.name ?? 'el operario';
  let returned = false;
  await confirm({
    title: `¿Forzar la devolución de ${tool.code}?`,
    message: h(
      'div.stack.stack-sm',
      h('p', 'Se marcará como devuelto por administración y desaparecerá de la pestaña «Guardar» de ', h('strong', holderName), '.'),
      h('p.small.subtle', 'Úsalo cuando el útil ya está en su sitio o el operario no puede devolverlo.'),
    ),
    confirmLabel: 'Forzar devolución',
    danger: true,
    icon: 'undo',
    tone: 'warning',
    onConfirm: async () => {
      try {
        await adminRequest('POST', `/admin/tools/${encodeURIComponent(tool.id)}/force-return`);
        returned = true;
        return true;
      } catch (err) {
        if (err.status === 401) return true; // the login screen takes over
        reportError(err, 'No se ha podido forzar la devolución.');
        return err.status === 404; // the tool no longer exists: close
      }
    },
  });
  if (returned) toast(`${tool.code} marcado como devuelto.`, { type: 'success' });
  return returned;
}

// ---------------------------------------------------------------------------
// Downloads and clipboard

/** File name from a Content-Disposition header (filename* or filename). */
export function filenameFromDisposition(value) {
  if (!value) return null;
  const extended = /filename\*\s*=\s*(?:[\w-]+'[^']*')?("?)([^";]+)\1/i.exec(value);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(value);
  const name = plain ? (plain[1] ?? plain[2] ?? '').trim() : '';
  return name || null;
}

/**
 * Downloads an admin file (the request needs the Authorization header, so it is fetched
 * and saved through an object URL). Resolves to the saved file name.
 */
export async function downloadAdminFile(path, fallbackName) {
  const res = await adminRequest('GET', path, { as: 'response', timeout: 180_000 });
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('content-disposition')) || fallbackName;
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}

/** Copies text to the clipboard (with a fallback for plain-HTTP pages). */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // try the fallback below
  }
  const area = h('textarea', {
    value: text,
    readOnly: true,
    'aria-hidden': 'true',
    style: { position: 'fixed', top: '-1000px', left: '0', opacity: '0' },
  });
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// ---------------------------------------------------------------------------
// Form helpers

/**
 * Switch (checkbox with role="switch").
 * @returns {{ el: HTMLElement, input: HTMLInputElement }}
 */
export function switchControl({ checked = false, label, hint, onChange } = {}) {
  const input = h('input.adm-switch-input', { type: 'checkbox', role: 'switch', checked, onChange });
  const el = h(
    'label.adm-switch',
    input,
    h('span.adm-switch-track', { 'aria-hidden': 'true' }, h('span.adm-switch-thumb')),
    h('span.adm-switch-text', h('span.adm-switch-label', label), hint ? h('span.adm-switch-hint', hint) : null),
  );
  return { el, input };
}

/**
 * Submits a form with Enter from any single-line field by clicking `getButton()`
 * (dialog footers live outside the <form>).
 */
export function submitOnEnter(form, getButton) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    getButton()?.click();
  });
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type === 'checkbox' || target.type === 'radio') return;
    event.preventDefault();
    getButton()?.click();
  });
}

/** Primary button of a layer footer (ui.openLayer). */
export function primaryAction(layer) {
  return layer?.footer?.querySelector('.btn-primary, .btn-danger') ?? null;
}

/** PIN text input (digits only, numeric keyboard). */
export function pinInput({ maxLength = 6, placeholder, autocomplete = 'off', secret = false } = {}) {
  const el = h('input.input.input-mono.adm-pin-input', {
    type: secret ? 'password' : 'text',
    inputmode: 'numeric',
    pattern: '[0-9]*',
    maxlength: String(maxLength),
    autocomplete,
    spellcheck: 'false',
    placeholder: placeholder || null,
  });
  el.addEventListener('input', () => {
    const clean = el.value.replace(/\D+/g, '').slice(0, maxLength);
    if (clean !== el.value) el.value = clean;
  });
  return el;
}

/** Number of distinct values of `key(item)`. */
export function countDistinct(items, key) {
  return new Set(items.map(key)).size;
}
