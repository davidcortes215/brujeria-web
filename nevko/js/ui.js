// Interaction layer: modal layers (dialog / sheet / panel), confirm, dropdown menu,
// toasts, busy buttons, live-updating times, animated removal and back-button capture.
//
// Every overlay is accessible: role=dialog + aria-modal, focus moved inside and trapped,
// Esc closes, the background is inert, focus returns to the opener, and the Android
// back button closes the overlay instead of leaving the page.

import { append, h } from './dom.js';
import { icon } from './icons.js';
import { button } from './components.js';

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const reducedMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

/** True when the user asked the system to minimise animations. */
export function prefersReducedMotion() {
  return Boolean(reducedMotionQuery?.matches);
}

function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0),
  );
}

function focusSafely(el) {
  if (!el || typeof el.focus !== 'function') return;
  try {
    el.focus({ preventScroll: false });
  } catch {
    el.focus();
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Back button capture

const backStack = [];
let backSeq = 0;

window.addEventListener('popstate', (event) => {
  const depth = typeof event.state?.ttLayerDepth === 'number' ? event.state.ttLayerDepth : 0;
  while (backStack.length > depth) {
    const entry = backStack.pop();
    if (entry.releasing) entry.settle();
    else entry.onBack();
  }
});

/**
 * Makes the next "back" (Android back button, browser back) call `onBack` instead of
 * navigating. Adds a same-URL history entry. Returns { release(): Promise } that removes
 * the entry again (resolves once the history has settled, so it is safe to navigate).
 */
export function captureBack(onBack) {
  const entry = { id: ++backSeq, onBack, releasing: false, settle: () => {} };
  backStack.push(entry);
  window.history.pushState({ ...(window.history.state ?? {}), ttLayer: entry.id, ttLayerDepth: backStack.length }, '');
  return {
    release() {
      const i = backStack.indexOf(entry);
      if (i === -1) return Promise.resolve();
      if (i !== backStack.length - 1) {
        // Not on top (closed out of order): forget it; its entry becomes a no-op.
        backStack.splice(i, 1);
        return Promise.resolve();
      }
      entry.releasing = true;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const j = backStack.indexOf(entry);
          if (j !== -1) backStack.splice(j, 1);
          resolve();
        }, 500);
        entry.settle = () => {
          clearTimeout(timer);
          resolve();
        };
        window.history.back();
      });
    },
  };
}

/** Forgets every capture without touching the history (used when the route changes). */
export function dropBackCaptures() {
  backStack.length = 0;
}

// ---------------------------------------------------------------------------
// Layers (dialog / sheet / panel)

const layers = [];
let layerSeq = 0;

function overlaysRoot() {
  let root = document.getElementById('overlays');
  if (!root) {
    root = h('div#overlays');
    document.body.append(root);
  }
  return root;
}

function setBackgroundInert() {
  const app = document.getElementById('app');
  const top = layers[layers.length - 1] ?? null;
  const blocked = layers.length > 0;
  if (app) {
    if (blocked) {
      app.setAttribute('inert', '');
      app.setAttribute('aria-hidden', 'true');
    } else {
      app.removeAttribute('inert');
      app.removeAttribute('aria-hidden');
    }
  }
  for (const layer of layers) {
    if (layer === top) layer.el.removeAttribute('inert');
    else layer.el.setAttribute('inert', '');
  }
  document.body.classList.toggle('is-scroll-locked', blocked);
}

document.addEventListener('focusin', (event) => {
  const top = layers[layers.length - 1];
  if (top && !top.el.contains(event.target) && !event.target.closest?.('.toast-region, .menu')) {
    const first = focusables(top.modal)[0] ?? top.modal;
    focusSafely(first);
  }
});

/**
 * Opens a modal layer.
 * @param {object} o
 * @param {'dialog'|'sheet'|'panel'} [o.kind='dialog'] dialog: centred card; sheet: bottom sheet on
 *        phones / dialog on larger screens; panel: full screen on phones / right drawer on larger screens
 * @param {string} [o.title]
 * @param {string} [o.description] text under the title
 * @param {string} [o.icon] icon shown next to the title
 * @param {'primary'|'danger'|'warning'|'success'} [o.tone='primary'] colour of the icon
 * @param {Node|Node[]|string} [o.content] body content
 * @param {Array<{label:string, variant?:string, icon?:string, value?:*, autofocus?:boolean,
 *          onClick?:(layer)=>any}>} [o.actions] footer buttons. onClick may be async (the button shows
 *          a spinner); returning false keeps the layer open. Without onClick the layer closes with `value`.
 * @param {boolean} [o.dismissible=true] Esc, backdrop and back button close it (with value undefined)
 * @param {boolean} [o.closeButton] show an X button (default: true for sheet/panel)
 * @param {boolean} [o.wide] wider dialog (640 px)
 * @param {Element|string} [o.initialFocus] element or selector to focus first
 * @param {(value)=>void} [o.onClose]
 * @returns {{el:HTMLElement, modal:HTMLElement, body:HTMLElement, footer:HTMLElement|null,
 *            close:(value?)=>Promise, closed:Promise, setActions:(actions)=>void}}
 */
export function openLayer({
  kind = 'dialog',
  title,
  description,
  icon: iconName,
  tone = 'primary',
  content,
  actions = [],
  dismissible = true,
  closeButton = kind !== 'dialog',
  wide = false,
  className,
  initialFocus,
  onClose,
} = {}) {
  const id = `layer-${++layerSeq}`;
  const opener = document.activeElement;
  let isClosed = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const titleId = `${id}-title`;
  const descriptionId = `${id}-desc`;
  const body = h('div.modal-body');
  append(body, content);
  const footer = h('div.modal-footer');

  const header =
    title || closeButton || iconName
      ? h(
          'div.modal-header',
          iconName ? h('div.modal-icon', { class: tone !== 'primary' ? `modal-icon-${tone}` : null }, icon(iconName, { size: 22 })) : null,
          h(
            'div.modal-heading',
            title ? h('h2.modal-title', { id: titleId }, title) : null,
            description ? h('p.modal-description', { id: descriptionId }, description) : null,
          ),
          closeButton
            ? button({ icon: 'x', label: 'Cerrar', variant: 'ghost', iconOnly: true, className: 'modal-close', onClick: () => close(undefined) })
            : null,
        )
      : null;

  const modal = h(
    'div.modal',
    {
      role: tone === 'danger' && kind === 'dialog' ? 'alertdialog' : 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': title ? titleId : null,
      'aria-describedby': description ? descriptionId : null,
      class: { 'modal-wide': wide },
      tabIndex: -1,
    },
    kind === 'sheet' ? h('div.sheet-handle', { 'aria-hidden': 'true' }) : null,
    header,
    body,
    footer,
  );
  const backdrop = h('div.layer-backdrop', {
    onClick: () => {
      if (dismissible) close(undefined);
    },
  });
  const el = h(`div.layer.layer-${kind}`, { class: className, id }, backdrop, modal);

  const layer = { el, modal, body, footer, close, closed, setActions };

  function setActions(list) {
    footer.replaceChildren();
    for (const action of list ?? []) {
      const btn = button({
        label: action.label,
        icon: action.icon,
        variant: action.variant ?? 'secondary',
        attrs: action.autofocus ? { 'data-autofocus': '' } : {},
        onClick: async () => {
          if (typeof action.onClick !== 'function') {
            close(action.value);
            return;
          }
          btn.classList.add('is-loading');
          btn.setAttribute('aria-busy', 'true');
          footer.querySelectorAll('button').forEach((b) => (b.disabled = true));
          let result;
          try {
            result = await action.onClick(layer);
          } catch (err) {
            result = false;
            console.error(err);
          } finally {
            btn.classList.remove('is-loading');
            btn.removeAttribute('aria-busy');
            footer.querySelectorAll('button').forEach((b) => (b.disabled = false));
          }
          if (result !== false) close(action.value ?? result);
        },
      });
      footer.append(btn);
    }
    footer.hidden = footer.childElementCount === 0;
  }
  setActions(actions);

  el.addEventListener('keydown', (event) => {
    if (layers[layers.length - 1] !== layer) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (dismissible) close(undefined);
      return;
    }
    if (event.key === 'Tab') {
      const items = focusables(modal);
      if (items.length === 0) {
        event.preventDefault();
        focusSafely(modal);
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !modal.contains(active))) {
        event.preventDefault();
        focusSafely(last);
      } else if (!event.shiftKey && (active === last || !modal.contains(active))) {
        event.preventDefault();
        focusSafely(first);
      }
    }
  });

  let back = null;
  const captureBackButton = () => {
    back = captureBack(() => {
      back = null;
      if (dismissible) close(undefined, { viaBack: true });
      else captureBackButton(); // cannot be dismissed: keep intercepting
    });
  };

  function close(value, { viaBack = false, immediate = false } = {}) {
    if (isClosed) return closed;
    isClosed = true;
    const i = layers.indexOf(layer);
    if (i !== -1) layers.splice(i, 1);
    setBackgroundInert();

    const release = !viaBack && back ? back.release() : Promise.resolve();
    back = null;
    const animate = immediate || prefersReducedMotion() ? Promise.resolve() : (el.classList.add('is-closing'), wait(130));

    Promise.all([release, animate]).then(() => {
      el.remove();
      if (opener && opener.isConnected && !layers.length) focusSafely(opener);
      try {
        onClose?.(value);
      } finally {
        resolveClosed(value);
      }
    });
    return closed;
  }

  overlaysRoot().append(el);
  layers.push(layer);
  setBackgroundInert();
  captureBackButton();

  // Initial focus: explicit target, [data-autofocus] action, first field, first action, the dialog.
  requestAnimationFrame(() => {
    if (isClosed) return;
    let target = typeof initialFocus === 'string' ? modal.querySelector(initialFocus) : initialFocus;
    target ??= modal.querySelector('[data-autofocus]');
    target ??= body.querySelector('input, select, textarea');
    target ??= footer.querySelector('button');
    target ??= focusables(modal)[0];
    focusSafely(target ?? modal);
  });

  return layer;
}

/** Centered dialog (see openLayer). */
export const dialog = (options) => openLayer({ ...options, kind: 'dialog' });
/** Bottom sheet on phones, dialog on larger screens (see openLayer). */
export const sheet = (options) => openLayer({ ...options, kind: 'sheet' });
/** Full-screen panel on phones, right drawer on larger screens (see openLayer). */
export const panel = (options) => openLayer({ ...options, kind: 'panel' });

/**
 * Confirmation dialog. Resolves true when confirmed, false otherwise.
 *   if (await confirm({ title: '¿Marcar todo como guardado?', message: '…', confirmLabel: 'Marcar todo' })) …
 * `onConfirm` (optional, async) runs inside the dialog with a spinner; if it throws or
 * returns false the dialog stays open.
 */
export async function confirm({
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  danger = false,
  icon: iconName,
  tone,
  onConfirm,
} = {}) {
  const layer = dialog({
    title,
    icon: iconName ?? (danger ? 'alert-triangle' : null),
    tone: tone ?? (danger ? 'danger' : 'primary'),
    content: message ? (typeof message === 'string' ? h('p', message) : message) : null,
    actions: [
      { label: cancelLabel, variant: 'secondary', value: false },
      {
        label: confirmLabel,
        variant: danger ? 'danger' : 'primary',
        value: true,
        autofocus: !danger,
        onClick: onConfirm ? async () => ((await onConfirm()) === false ? false : true) : undefined,
      },
    ],
  });
  if (danger) layer.footer.querySelector('button')?.setAttribute('data-autofocus', '');
  const value = await layer.closed;
  return value === true;
}

/** Closes every open layer and menu at once (route change). Does not touch the history. */
export function closeAll() {
  dropBackCaptures();
  for (const layer of [...layers].reverse()) layer.close(undefined, { viaBack: true, immediate: true });
  if (openMenu) openMenu.close({ viaBack: true, restoreFocus: false });
}

/** True while a modal layer is open. */
export function hasOpenLayer() {
  return layers.length > 0;
}

// ---------------------------------------------------------------------------
// Dropdown menu

let openMenu = null;

/**
 * Opens a dropdown menu anchored to `anchor`.
 * items: [
 *   { label, icon, onSelect, danger, disabled, checked },   // checked: boolean -> menuitemradio
 *   { label, icon, onSelect, checked, checkbox: true },     // on/off option -> menuitemcheckbox
 *   { separator: true },
 *   { heading: 'Tema' },
 * ]
 * header: optional Node shown at the top (e.g. operator name).
 * Returns { close }.
 */
export function menu(anchor, { items = [], header, label, align = 'end' } = {}) {
  if (openMenu) openMenu.close({ restoreFocus: false });

  const itemEls = [];
  const el = h('div.menu', { role: 'menu', 'aria-label': label || null, tabIndex: -1 });
  const scrim = h('div', { class: 'menu-scrim', 'aria-hidden': 'true' });
  if (header) el.append(h('div.menu-header', header));

  for (const item of items) {
    if (item.separator) {
      el.append(h('div.menu-sep', { role: 'separator' }));
      continue;
    }
    if (item.heading) {
      el.append(h('div.menu-label', { role: 'presentation' }, item.heading));
      continue;
    }
    const isRadio = typeof item.checked === 'boolean';
    const btn = h(
      'button.menu-item',
      {
        type: 'button',
        role: isRadio ? (item.checkbox ? 'menuitemcheckbox' : 'menuitemradio') : 'menuitem',
        'aria-checked': isRadio ? String(item.checked) : null,
        'aria-disabled': item.disabled ? 'true' : null,
        tabIndex: -1,
        class: { 'is-danger': item.danger },
        onClick: async () => {
          if (item.disabled) return;
          await close({ restoreFocus: false });
          item.onSelect?.();
        },
      },
      item.icon ? icon(item.icon) : null,
      h('span.menu-item-label', item.label),
      isRadio ? icon('check', { className: 'menu-check', size: 18 }) : null,
    );
    itemEls.push(btn);
    el.append(btn);
  }

  let back = null;
  let closedFlag = false;

  function close({ viaBack = false, restoreFocus = true } = {}) {
    if (closedFlag) return Promise.resolve();
    closedFlag = true;
    if (openMenu?.el === el) openMenu = null;
    el.remove();
    scrim.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onResize);
    if (restoreFocus && anchor.isConnected) focusSafely(anchor);
    const release = !viaBack && back ? back.release() : Promise.resolve();
    back = null;
    return release;
  }

  function focusItem(index) {
    const enabled = itemEls.filter((b) => b.getAttribute('aria-disabled') !== 'true');
    if (!enabled.length) return;
    const i = (index + enabled.length) % enabled.length;
    focusSafely(enabled[i]);
  }

  function onKeydown(event) {
    const enabled = itemEls.filter((b) => b.getAttribute('aria-disabled') !== 'true');
    const current = enabled.indexOf(document.activeElement);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusItem(current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(enabled.length - 1);
        break;
      case 'Tab':
        close({ restoreFocus: false });
        break;
      default:
    }
  }

  function position() {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = align === 'end' ? rect.right - width : rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin && rect.top - height - 6 > margin) top = rect.top - height - 6;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(margin, top))}px`;
  }

  const onResize = () => close({ restoreFocus: false });

  scrim.addEventListener('click', () => close());
  document.body.append(scrim, el);
  position();
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', onResize);
  back = captureBack(() => {
    back = null;
    close({ viaBack: true });
  });
  requestAnimationFrame(() => {
    if (closedFlag) return;
    const checked = itemEls.find((b) => b.getAttribute('aria-checked') === 'true');
    focusSafely(itemEls[0] ?? checked ?? el);
  });

  openMenu = { el, close };
  return { close };
}

// ---------------------------------------------------------------------------
// Toasts

const MAX_TOASTS = 3;
const TOAST_ICONS = { info: 'info', success: 'check-circle', warning: 'alert-triangle', error: 'alert-circle' };

function toastRegion() {
  let region = document.getElementById('toasts');
  if (!region) {
    region = h('div#toasts.toast-region', { 'aria-live': 'polite' });
    document.body.append(region);
  }
  return region;
}

/**
 * Shows a toast.
 *   toast('UT-0012 añadido a tus útiles en uso', { type: 'success' })
 *   toast('UT-0012 guardado', { action: { label: 'Deshacer', onClick: undo } })
 * @param {string} message
 * @param {object} [o]
 * @param {'info'|'success'|'warning'|'error'} [o.type='info']
 * @param {{label:string, onClick:Function}} [o.action]
 * @param {number} [o.duration] ms (default 3500; 5000 with an action; 6000 for errors; 0 = until dismissed)
 * @returns {{dismiss:()=>void, el:HTMLElement}}
 */
export function toast(message, { type = 'info', action, duration } = {}) {
  const region = toastRegion();
  const ms = duration ?? (type === 'error' ? 6000 : action ? 5000 : 3500);
  let timer = null;
  let remaining = ms;
  let startedAt = 0;
  let gone = false;

  const el = h('div.toast', { class: `toast-${type}`, role: type === 'error' ? 'alert' : 'status' });
  el.append(icon(TOAST_ICONS[type] ?? 'info'), h('div.toast-message', message));
  if (action) {
    el.append(
      h(
        'button.toast-action',
        {
          type: 'button',
          onClick: () => {
            dismiss();
            action.onClick?.();
          },
        },
        action.label,
      ),
    );
  }
  if (type === 'error' || ms === 0) {
    el.append(h('button.toast-close', { type: 'button', 'aria-label': 'Cerrar aviso', onClick: () => dismiss() }, icon('x', { size: 18 })));
  }

  function start() {
    if (ms <= 0 || gone) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  }
  function pause() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(1200, remaining - (Date.now() - startedAt));
  }
  function dismiss() {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    if (prefersReducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  }

  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', start);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', start);

  const visible = Array.from(region.children).filter((t) => !t.classList.contains('is-leaving'));
  if (visible.length >= MAX_TOASTS) visible[0].remove();
  region.append(el);
  start();
  return { dismiss, el };
}

/** Error toast from an ApiError (or any error). Ignores aborted requests. */
export function toastError(error, fallback = 'No se ha podido completar la operación.') {
  if (error?.code === 'ABORTED') return null;
  if (error && !(error.status >= 0)) console.error(error);
  return toast(error?.message || fallback, { type: error?.isNetwork ? 'warning' : 'error' });
}

// ---------------------------------------------------------------------------
// Busy state

/** Shows a spinner on a button and disables it (or restores it). */
export function setBusy(buttonEl, busy) {
  if (!buttonEl) return;
  buttonEl.classList.toggle('is-loading', busy);
  buttonEl.disabled = busy;
  if (busy) buttonEl.setAttribute('aria-busy', 'true');
  else buttonEl.removeAttribute('aria-busy');
}

/** Runs `fn` with `buttonEl` busy; restores it afterwards (if still in the page). */
export async function withBusy(buttonEl, fn) {
  setBusy(buttonEl, true);
  try {
    return await fn();
  } finally {
    if (buttonEl?.isConnected) setBusy(buttonEl, false);
  }
}

// ---------------------------------------------------------------------------
// Live times ("hace 5 min", "2 h 16 min") refreshed every 20 s

const LIVE_INTERVAL_MS = 20_000;
const liveEntries = new Set();
let liveTimer = null;

function renderLive(entry, now) {
  entry.el.textContent = entry.format(entry.value, now);
  entry.onTick?.(entry.el, now);
}

function tickLive() {
  const now = new Date();
  for (const entry of liveEntries) {
    if (!entry.el.isConnected) {
      if (Date.now() - entry.born > 5000) liveEntries.delete(entry);
      continue;
    }
    renderLive(entry, now);
  }
  if (!liveEntries.size) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && liveEntries.size) tickLive();
});

/**
 * Text that keeps itself up to date.
 *   liveTime(tool.holder.since, fmt.relative)          -> 'hace 5 min' ... 'hace 6 min'
 *   liveTime(since, fmt.elapsed, { onTick: (el, now) => el.classList.toggle('text-danger', ...) })
 * @param {string|Date} value timestamp
 * @param {(value, now:Date)=>string} format
 * @param {{tag?:string, className?:string, onTick?:(el:HTMLElement, now:Date)=>void}} [o]
 */
export function liveTime(value, format, { tag = 'span', className, onTick } = {}) {
  const el = h(tag, { class: className });
  const entry = { el, value, format, onTick, born: Date.now() };
  renderLive(entry, new Date());
  liveEntries.add(entry);
  if (!liveTimer) liveTimer = setInterval(tickLive, LIVE_INTERVAL_MS);
  return el;
}

// ---------------------------------------------------------------------------
// Animated removal

/**
 * Collapses an element (height, padding and opacity to 0). Resolves when finished;
 * the caller removes the element. Immediate with reduced motion.
 */
export function collapseOut(el) {
  if (!el?.isConnected || prefersReducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    const height = el.getBoundingClientRect().height;
    el.style.height = `${height}px`;
    el.classList.add('is-collapsing');
    void el.offsetHeight; // commit the start height
    el.classList.add('is-collapsed');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    el.addEventListener('transitionend', (event) => event.propertyName === 'height' && finish());
    setTimeout(finish, 320);
  });
}

// ---------------------------------------------------------------------------
// Screen reader announcements

/** Announces a short message to screen readers (polite). */
export function announce(message) {
  let region = document.getElementById('sr-announcer');
  if (!region) {
    region = h('div#sr-announcer.sr-only', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(region);
  }
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 60);
}

/** Vibrates when supported (Android). Silently ignored elsewhere. */
export function vibrate(pattern) {
  try {
    // Without a user gesture yet the browser refuses it and logs an intervention.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    // Not allowed (no user gesture yet) or unsupported.
  }
}
