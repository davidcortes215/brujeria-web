// Reusable UI building blocks (pure element factories, no global state).
// Each returns a DOM element styled by css/app.css. See public/js/README.md.

import { h, append } from './dom.js';
import { icon, logoMark } from './icons.js';
import * as fmt from './fmt.js';

let uid = 0;
/** Unique id for aria wiring: uniqueId('field') -> 'field-7'. */
export function uniqueId(prefix = 'tt') {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Button (or link when `href` is given).
 * @param {object} o
 * @param {string} [o.label] visible text
 * @param {string} [o.icon] leading icon name
 * @param {string} [o.iconRight] trailing icon name
 * @param {'primary'|'secondary'|'ghost'|'danger'|'danger-ghost'|'warning'} [o.variant='secondary']
 * @param {'sm'|'md'|'lg'} [o.size='md']
 * @param {boolean} [o.block] full width
 * @param {boolean} [o.iconOnly] square icon button (requires `ariaLabel` or `label` used as aria-label)
 * @param {string} [o.ariaLabel]
 * @param {Function} [o.onClick]
 * @param {string} [o.type='button']
 * @param {string} [o.href] renders an <a>
 */
export function button({
  label = '',
  icon: iconName,
  iconRight,
  variant = 'secondary',
  size = 'md',
  block = false,
  iconOnly = false,
  ariaLabel,
  title,
  onClick,
  type = 'button',
  href,
  disabled = false,
  className,
  attrs = {},
} = {}) {
  const classes = [
    'btn',
    `btn-${variant}`,
    size !== 'md' && `btn-${size}`,
    block && 'btn-block',
    iconOnly && 'btn-icon',
    className,
  ].filter(Boolean);
  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 22 : 20;
  const children = [
    iconName ? icon(iconName, { size: iconSize }) : null,
    label && !iconOnly ? h('span.btn-label', label) : null,
    iconRight ? icon(iconRight, { size: iconSize }) : null,
  ];
  const common = {
    class: classes,
    title: title || null,
    'aria-label': ariaLabel || (iconOnly ? label : null),
    onClick,
    ...attrs,
  };
  if (href) return h('a', { ...common, href, 'aria-disabled': disabled ? 'true' : null }, children);
  return h('button', { ...common, type, disabled }, children);
}

/** Square icon-only button with an accessible label. */
export function iconButton({ icon: iconName, label, variant = 'ghost', size = 'md', onClick, className, attrs } = {}) {
  return button({ icon: iconName, label, variant, size, iconOnly: true, onClick, className, attrs, title: label });
}

// ---------------------------------------------------------------------------
// Tool status

/** 'mine' | 'other' | 'available' | 'inactive' */
export function toolStatus(tool) {
  if (tool?.holder?.isMe) return 'mine';
  if (tool?.holder) return 'other';
  if (tool && tool.active === false) return 'inactive';
  return 'available';
}

/** Generic pill: pill('available', 'Disponible'). Kinds: available | other | mine | inactive | danger | neutral. */
export function pill(kind, text, { large = false, title } = {}) {
  return h(
    'span.pill',
    { class: [kind !== 'neutral' && `pill-${kind}`, large && 'pill-lg'], title: title || null },
    h('span.pill-text', text),
  );
}

/** Status pill of a tool: Disponible / En uso · Nombre / Lo tienes tú / Dado de baja. */
export function statusPill(tool, options = {}) {
  switch (toolStatus(tool)) {
    case 'mine':
      return pill('mine', 'Lo tienes tú', options);
    case 'other':
      return pill('other', `En uso · ${tool.holder.name}`, { ...options, title: `En uso por ${tool.holder.name}` });
    case 'inactive':
      return pill('inactive', 'Dado de baja', options);
    default:
      return pill('available', 'Disponible', options);
  }
}

/** Small neutral or coloured label: tag('Dado de baja', 'warning'). */
export function tag(text, tone) {
  return h('span.tag', { class: tone ? `tag-${tone}` : null }, text);
}

/** Count badge. */
export function badge(n, { neutral = false } = {}) {
  return h('span.badge', { class: { 'badge-neutral': neutral } }, n > 99 ? '99+' : String(n));
}

// ---------------------------------------------------------------------------
// Units and kits (Tool.unitIndex / unitCount / container)

/** "Unidad 2 de 3" tag when the tool's code has several active units; null otherwise. */
export function unitTag(tool) {
  const text = fmt.unitLabel(tool);
  return text ? h('span.tag.tag-unit', text) : null;
}

/**
 * Muted " (en AR1)" to write after the location of a tool that is inside a kit
 * (Tool.container: "INCLUIDO EN VAT 8015" -> the kit is in AR1). The location itself is never
 * changed. Several kit locations are joined with " · ". Null when there is nothing to add.
 */
export function containerHint(tool) {
  const places = fmt.containerPlaces(tool?.container);
  if (!places) return null;
  return h('span.loc-hint', { title: fmt.containerSentence(tool.container) }, ` (en${NBSP}${fmt.keepHyphens(places)})`);
}

// ---------------------------------------------------------------------------
// Zone cards (Guardar, En lista): <li class="stop"> = zoneHead() + <ul class="stop-items">

/**
 * Head of a zone card: walk order number, "Zona", the zone name in large type (zones.js
 * `group.label`: "Armario AR2", "Fila FB", "TALLER") and the tool count; `action` (e.g.
 * "Coger los 3") goes under the name.
 * @param {object} o
 * @param {number} o.index 0-based position in the walk
 * @param {string} o.zone zone name for people (zoneLabel)
 * @param {boolean} [o.empty] tools without a location
 * @param {number} [o.count] tools in the zone (shown from 2)
 * @param {Node} [o.action]
 */
export function zoneHead({ index, zone, empty = false, count = 0, action = null } = {}) {
  return h(
    'div.stop-head',
    h('span.stop-index', { 'aria-hidden': 'true' }, String(index + 1)),
    h(
      'div.stop-head-text',
      // The count shares the label row, so the zone name keeps the whole width.
      h('div.stop-label-row', h('div.stop-label', 'Zona'), count > 1 ? h('span.stop-count', tag(fmt.tools(count), 'primary')) : null),
      h(
        'div.stop-loc',
        { class: { 'is-empty': empty }, dataset: { length: empty ? null : fmt.locationLength(zone) } },
        empty ? 'Sin ubicación asignada' : fmt.keepHyphens(zone),
      ),
      action ? h('div.stop-head-action', action) : null,
    ),
  );
}

/**
 * Where a tool goes inside its zone: the slot for people ("B4", "Cajón 4", "Módulo 1 · Balda 3",
 * "en VAT 8015": zones.js `entries[i].slotLabel`) in large type and the whole location small
 * under it, followed by `hint` (containerHint(): where the kit is). Nothing when there is no
 * slot (the zone says it all).
 */
export function slotLines(location, slot, hint = null) {
  if (!slot) return null;
  return [h('div.stop-item-slot', slotText(slot)), h('div.stop-item-loc', fmt.keepHyphens(location), hint)];
}

const NBSP = '\u00a0';

/**
 * Slot text for large type: a number or a one/two-letter part stays on the line of the word
 * before it, "en" on the line of the kit code and " · " breaks after the dot, so
 * "Módulo 1 · Balda 3" wraps as "Módulo 1 ·" / "Balda 3" (never "Balda" / "3") and
 * "Cajón 3 · en VAT 8015" as "Cajón 3 ·" / "en VAT 8015".
 */
function slotText(slot) {
  return fmt
    .keepHyphens(slot)
    .replace(/ \u00b7 /g, `${NBSP}\u00b7 `)
    .replace(/(?<!\u00b7) (?=\d|\S{1,2}(?: |$))/g, NBSP)
    .replace(/(^|\s)en /g, `$1en${NBSP}`); // "en VAT 8015" (a tool inside a kit) stays together
}

// ---------------------------------------------------------------------------
// People & brand

/** Avatar with initials and a stable colour per name. size: 'sm' | 'md' | 'lg' | 'xl'. */
export function avatar(name, { size = 'md' } = {}) {
  return h(
    'span.avatar',
    { class: size !== 'md' ? `avatar-${size}` : null, dataset: { tone: fmt.tone(name) }, 'aria-hidden': 'true' },
    fmt.initials(name),
  );
}

/** Brand block: logo mark + "Nevko" (+ optional section name). */
export function brand({ subtitle, href = '#/buscar' } = {}) {
  const children = [
    logoMark({ size: 30 }),
    h('span', 'Nevko'),
    subtitle ? [h('span.brand-sep', { 'aria-hidden': 'true' }, '·'), h('span.brand-sub', subtitle)] : null,
  ];
  return href
    ? h('a.brand', { href, 'aria-label': subtitle ? `Nevko · ${subtitle}` : 'Nevko, inicio' }, children)
    : h('span.brand', children);
}

// ---------------------------------------------------------------------------
// States

/**
 * Empty / error / info state.
 * @param {object} o
 * @param {string} [o.icon='inbox']
 * @param {string} o.title
 * @param {string|Node} [o.text]
 * @param {Node} [o.action] e.g. a button()
 * @param {'default'|'success'|'danger'} [o.tone]
 * @param {boolean} [o.compact]
 */
export function emptyState({ icon: iconName = 'inbox', title, text, action, tone = 'default', compact = false } = {}) {
  return h(
    'div.empty',
    { class: { 'empty-success': tone === 'success', 'empty-danger': tone === 'danger', 'empty-compact': compact } },
    h('div.empty-icon', icon(iconName, { size: 26 })),
    h('p.empty-title', title),
    text ? h('p.empty-text', text) : null,
    action ? h('div.empty-action', action) : null,
  );
}

/** Error state with a "Reintentar" button. */
export function errorState(error, onRetry, { title = 'No se ha podido cargar' } = {}) {
  return emptyState({
    icon: error?.isNetwork ? 'wifi-off' : 'alert-triangle',
    tone: 'danger',
    title,
    text: error?.message || 'Ha ocurrido un error inesperado.',
    action: onRetry ? button({ label: 'Reintentar', icon: 'refresh', onClick: onRetry }) : null,
  });
}

/** Spinner. size: 'md' | 'lg'. */
export function spinner({ size = 'md', label = 'Cargando' } = {}) {
  return h('span.spinner', { class: { 'spinner-lg': size === 'lg' }, role: 'status', 'aria-label': label });
}

/** Centered spinner with a caption. */
export function loadingBlock(text = 'Cargando…') {
  return h('div.loading-block', spinner({ size: 'lg', label: text }), h('span', text));
}

/** Skeleton placeholders. variant: 'result' | 'card' | 'row' | 'operator'. */
export function skeleton(count = 3, variant = 'result') {
  const line = (width, cls = 'skeleton-line') => h(`div.skeleton.${cls}`, { style: { width } });
  const items = [];
  for (let i = 0; i < count; i++) {
    if (variant === 'operator') {
      items.push(
        h(
          'li.skeleton-card',
          { style: { justifyItems: 'center', minHeight: '128px', alignContent: 'center' } },
          h('div.skeleton.skeleton-circle', { style: { width: '48px', height: '48px' } }),
          line(`${60 + ((i * 17) % 30)}%`),
        ),
      );
    } else if (variant === 'row') {
      items.push(
        h(
          'li.skeleton-row',
          { style: { padding: '12px 16px' } },
          h('div.skeleton.skeleton-circle', { style: { width: '32px', height: '32px', flex: 'none' } }),
          h('div', { style: { flex: '1', display: 'grid', gap: '8px' } }, line('40%'), line('65%')),
        ),
      );
    } else {
      items.push(
        h(
          'li.skeleton-card',
          h('div.row.row-between', line(`${35 + ((i * 13) % 20)}%`, 'skeleton-title'), line('84px', 'skeleton-title')),
          line(`${45 + ((i * 11) % 30)}%`),
          line(`${60 + ((i * 7) % 30)}%`),
        ),
      );
    }
  }
  return h(
    'ul',
    {
      class: variant === 'operator' ? 'op-grid' : variant === 'row' ? 'list' : 'results',
      'aria-busy': 'true',
      'aria-label': 'Cargando',
    },
    items,
  );
}

/** Inline alert. type: 'info' | 'success' | 'warning' | 'danger'. */
export function alertBox({ type = 'info', title, text, action } = {}) {
  const icons = { info: 'info', success: 'check-circle', warning: 'alert-triangle', danger: 'alert-circle' };
  return h(
    'div.alert',
    { class: type !== 'info' ? `alert-${type}` : null, role: type === 'danger' ? 'alert' : null },
    icon(icons[type] ?? 'info'),
    h(
      'div.alert-body',
      title ? h('div.alert-title', title) : null,
      text ? h('div.alert-text', text) : null,
      action ? h('div.alert-actions', action) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Forms

/**
 * Form field: label + control + hint + error, wired with ids and aria attributes.
 * Returns the wrapper; `wrapper.setError(message|null)` shows/hides the error.
 */
export function field({ label, control, hint, error, optional = false, id } = {}) {
  const controlId = id || control.id || uniqueId('field');
  control.id = controlId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hintEl = hint ? h('div.field-hint', { id: hintId }, hint) : null;
  const errorText = h('span');
  const errorEl = h('div.field-error', { id: errorId, hidden: true, role: 'alert' }, icon('alert-circle', { size: 14 }), errorText);
  const wrapper = h(
    'div.field',
    h('label.field-label', { htmlFor: controlId }, label, optional ? h('span.field-optional', ' (opcional)') : null),
    control,
    hintEl,
    errorEl,
  );
  const describedBy = () => [hintEl && hintId, !errorEl.hidden && errorId].filter(Boolean).join(' ') || null;
  wrapper.setError = (message) => {
    errorText.textContent = message || '';
    errorEl.hidden = !message;
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
    const value = describedBy();
    if (value) control.setAttribute('aria-describedby', value);
    else control.removeAttribute('aria-describedby');
  };
  wrapper.setError(error);
  return wrapper;
}

/** <input class="input"> with sensible defaults. */
export function input({ type = 'text', value = '', placeholder, name, mono = false, size, attrs = {}, onInput } = {}) {
  return h('input.input', {
    type,
    value,
    placeholder: placeholder || null,
    name: name || null,
    class: { 'input-mono': mono, 'input-sm': size === 'sm' },
    onInput,
    ...attrs,
  });
}

/** <select class="select">. options: [{ value, label, disabled }]. */
export function select({ options = [], value, name, size, onChange, attrs = {} } = {}) {
  const el = h(
    'select.select',
    { name: name || null, class: { 'select-sm': size === 'sm' }, onChange, ...attrs },
    options.map((option) =>
      h('option', { value: String(option.value), disabled: option.disabled || false }, option.label),
    ),
  );
  if (value !== undefined && value !== null) el.value = String(value);
  return el;
}

/**
 * Segmented control (single choice), keyboard accessible (arrow keys).
 * options: [{ value, label, icon }]. Returns the element with `.value` getter/setter.
 */
export function segmented({ options, value, onChange, label, block = false } = {}) {
  let current = value;
  const buttons = options.map((option) =>
    h(
      'button.segmented-item',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(option.value === current),
        tabIndex: option.value === current ? 0 : -1,
        dataset: { value: String(option.value) },
        onClick: () => choose(option.value, true),
      },
      option.icon ? icon(option.icon, { size: 16 }) : null,
      option.label,
    ),
  );
  const el = h('div.segmented', { role: 'radiogroup', 'aria-label': label || null, class: { 'segmented-block': block } }, buttons);
  function sync() {
    buttons.forEach((btn, i) => {
      const selected = options[i].value === current;
      btn.setAttribute('aria-checked', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    });
  }
  function choose(next, notify) {
    if (next === current) return;
    current = next;
    sync();
    if (notify) onChange?.(current);
  }
  el.addEventListener('keydown', (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const i = options.findIndex((o) => o.value === current);
    const next = (i + keys[event.key] + options.length) % options.length;
    choose(options[next].value, true);
    buttons[next].focus();
  });
  Object.defineProperty(el, 'value', {
    get: () => current,
    set: (next) => choose(next, false),
  });
  return el;
}

// ---------------------------------------------------------------------------
// Admin helpers

/** KPI tile. tone: 'primary' | 'success' | 'warning' | 'danger'. */
export function kpi({ label, value, hint, icon: iconName, tone } = {}) {
  return h(
    'div.kpi',
    { class: tone ? `kpi-${tone}` : null },
    h('div.kpi-label', iconName ? icon(iconName, { size: 16 }) : null, label),
    h('div.kpi-value', typeof value === 'number' ? fmt.number(value) : value),
    hint ? h('div.kpi-hint', hint) : null,
  );
}

/** Card with optional header (title, subtitle, actions) and body. */
export function card({ title, subtitle, actions, body, padded = true, className } = {}) {
  const header =
    title || actions
      ? h(
          'div.card-header',
          h('div', title ? h('h2.card-title', title) : null, subtitle ? h('p.card-subtitle', subtitle) : null),
          actions ? h('div.row', actions) : null,
        )
      : null;
  const content = body === undefined ? null : padded ? h('div.card-body', body) : body;
  return h('section.card', { class: className }, header, content);
}

/** Page header: title + subtitle + optional trailing actions. */
export function pageHeader({ title, subtitle, actions, id } = {}) {
  return h(
    'header.page-header',
    h(
      'div.page-header-text',
      h('h1.page-title', { id: id || null, tabIndex: -1 }, title),
      subtitle ? h('p.page-subtitle', subtitle) : null,
    ),
    actions ? append(h('div.row'), actions) : null,
  );
}
