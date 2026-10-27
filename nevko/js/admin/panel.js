// #/admin/panel — KPI tiles, "En uso ahora" (oldest first, durations coloured above
// 8 h / 24 h) with "Forzar devolución", the last import and first steps on a new
// installation. Refreshed live from SSE events.

import { avatar, button, card, containerHint, emptyState, kpi, tag, unitTag } from '../components.js';
import { clear, h, replace } from '../dom.js';
import * as fmt from '../fmt.js';
import { icon } from '../icons.js';
import {
  DANGER_AFTER_MS,
  IMPORT_MODE_LABELS,
  adminRequest,
  countDistinct,
  dataTable,
  dateTimeCell,
  debounce,
  forceReturn,
  inlineError,
  liveDuration,
  pageHeader,
  tableSkeleton,
} from './common.js';

const REFRESH_DELAY_MS = 250;

export function mountPanel(root, env) {
  let destroyed = false;
  let data = null;
  let error = null;
  let controller = null;

  const header = pageHeader({
    title: 'Panel',
    subtitle: 'Estado del utillaje en tiempo real.',
    actions: button({ label: 'Importar catálogo', icon: 'upload', href: '#/admin/importar' }),
  });

  const onboarding = h('div.adm-onboarding', { hidden: true });
  const kpiBox = h('div.kpis.adm-kpis', { 'aria-live': 'polite' });
  const inUseBody = h('div.adm-card-flush');
  const inUseBadge = h('span.badge.badge-neutral', { hidden: true });
  const inUseCard = card({
    title: 'En uso ahora',
    subtitle: 'Del más antiguo al más reciente',
    actions: inUseBadge,
    body: inUseBody,
    padded: false,
    className: 'adm-inuse-card',
  });
  const importBody = h('div');
  const importCard = card({ title: 'Última importación', body: importBody });
  const quickCard = card({ title: 'Accesos rápidos', body: quickLinks(), padded: false });

  root.append(
    header.el,
    onboarding,
    kpiBox,
    h('div.adm-section', inUseCard),
    h('div.adm-panel-grid.adm-section', importCard, quickCard),
  );

  render();
  void load();

  const refreshSoon = debounce(() => void load(), REFRESH_DELAY_MS);

  // Data -------------------------------------------------------------------------

  async function load() {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const summary = await adminRequest('GET', '/admin/summary', { signal: mine.signal });
      if (destroyed || controller !== mine) return;
      data = summary;
      error = null;
    } catch (err) {
      if (destroyed || controller !== mine || err.code === 'ABORTED') return;
      if (err.status === 401) return; // the login screen takes over
      error = err;
    }
    render();
  }

  // Rendering ----------------------------------------------------------------------

  function render() {
    if (destroyed) return;
    if (!data) {
      if (error) {
        clear(kpiBox);
        replace(inUseBody, inlineError(error, retry));
        replace(importBody, h('p.small.subtle', 'Sin datos.'));
      } else {
        replace(kpiBox, ...Array.from({ length: 4 }, kpiSkeleton));
        replace(inUseBody, tableSkeleton(4, 5));
        replace(importBody, h('div.stack.stack-sm', h('div.skeleton.skeleton-line', { style: { width: '70%' } }), h('div.skeleton.skeleton-line', { style: { width: '45%' } })));
      }
      return;
    }
    const counts = data.counts ?? {};
    const inUse = Array.isArray(data.inUse) ? data.inUse : [];
    renderOnboarding(counts);
    renderKpis(counts, inUse);
    renderInUse(inUse);
    replace(importBody, lastImport(data.lastImport));
  }

  function retry() {
    error = null;
    render();
    void load();
  }

  function kpiSkeleton() {
    return h(
      'div.kpi',
      { 'aria-hidden': 'true' },
      h('div.skeleton.skeleton-line', { style: { width: '55%' } }),
      h('div.skeleton.adm-skeleton-value'),
    );
  }

  function renderKpis(counts, inUse) {
    const inactive = Math.max(0, (counts.tools ?? 0) - (counts.active ?? 0));
    const holders = countDistinct(inUse, (item) => item.holder?.operatorId);
    const overdue = inUse.filter((item) => fmt.elapsedMs(item.holder?.since) > DANGER_AFTER_MS).length;
    const inUseHint = counts.inUse
      ? [`por ${fmt.count(holders, 'operario', 'operarios')}`, overdue ? `${fmt.number(overdue)} más de 24 h` : null].filter(Boolean).join(' · ')
      : 'Ninguno ahora mismo';
    replace(
      kpiBox,
      kpi({
        label: 'Útiles activos',
        value: counts.active ?? 0,
        icon: 'tool',
        hint: inactive ? `${fmt.number(inactive)} dados de baja` : 'En el catálogo',
      }),
      kpi({ label: 'En uso', value: counts.inUse ?? 0, icon: 'clock', tone: counts.inUse ? 'warning' : undefined, hint: inUseHint }),
      kpi({
        label: 'Disponibles',
        value: counts.available ?? 0,
        icon: 'check-circle',
        tone: 'success',
        hint: counts.active ? `${Math.round(((counts.available ?? 0) / counts.active) * 100)} % del catálogo` : 'Listos para usar',
      }),
      kpi({ label: 'Operarios', value: counts.operators ?? 0, icon: 'users', hint: 'Activos' }),
    );
  }

  function renderInUse(inUse) {
    inUseBadge.hidden = inUse.length === 0;
    inUseBadge.textContent = fmt.number(inUse.length);
    if (inUse.length === 0) {
      replace(
        inUseBody,
        emptyState({
          icon: 'check-circle',
          tone: 'success',
          title: 'Ningún útil en uso',
          text: 'Cuando un operario use un útil aparecerá aquí con el tiempo que lleva fuera de su sitio.',
          compact: true,
        }),
      );
      return;
    }
    const table = dataTable({
      caption: 'Útiles en uso ahora',
      rows: inUse,
      columns: [
        {
          label: 'Útil',
          primary: true,
          className: 'adm-col-tool',
          cell: ({ tool }) =>
            h(
              'div.adm-tool-cell',
              h('span.adm-code', tool.code),
              unitTag(tool),
              tool.active === false ? tag('De baja') : null,
              tool.description ? h('span.adm-cell-sub.adm-sub-secondary', { title: tool.description }, tool.description) : null,
            ),
        },
        {
          label: 'Ubicación',
          className: 'adm-col-loc',
          cell: ({ tool }) => (tool.location ? [tool.location, containerHint(tool)] : h('span.subtle', 'Sin ubicación')),
        },
        {
          label: 'Operario',
          className: 'adm-col-person',
          cell: ({ holder }) => h('span.adm-person', avatar(holder.name, { size: 'sm' }), h('span.adm-person-name', holder.name)),
        },
        {
          label: 'En uso',
          className: 'cell-nowrap',
          cell: ({ holder }) =>
            h('div.adm-since', liveDuration(holder.since), h('span.adm-cell-sub.adm-sub-secondary', 'desde ', dateTimeCell(holder.since))),
        },
        {
          label: '',
          srLabel: 'Acciones',
          className: 'cell-actions',
          cell: ({ tool, holder }) => {
            // Full label on wide tables, "Devolver" on narrower ones (never a bare icon).
            const force = button({
              icon: 'undo',
              variant: 'warning',
              size: 'sm',
              ariaLabel: `Forzar la devolución de ${tool.code}`,
              title: `Forzar la devolución de ${tool.code}`,
              className: 'adm-force',
              onClick: async () => {
                if (await forceReturn({ ...tool, holder })) void load();
              },
            });
            force.append(h('span.btn-label.adm-force-long', 'Forzar devolución'), h('span.btn-label.adm-force-short', 'Devolver'));
            return force;
          },
        },
      ],
    });
    replace(
      inUseBody,
      h('div.table-wrap', table),
      h(
        'p.adm-legend',
        h('span.adm-legend-item', h('span.adm-legend-dot.is-warning', { 'aria-hidden': 'true' }), 'Más de 8 h'),
        h('span.adm-legend-item', h('span.adm-legend-dot.is-danger', { 'aria-hidden': 'true' }), 'Más de 24 h'),
      ),
    );
  }

  function lastImport(last) {
    if (!last) {
      return emptyState({
        icon: 'file-text',
        title: 'Todavía no se ha importado ningún catálogo',
        text: 'Sube el listado de utillaje en PDF o CSV.',
        compact: true,
        action: button({ label: 'Importar catálogo', icon: 'upload', variant: 'primary', size: 'sm', href: '#/admin/importar' }),
      });
    }
    const rows = [
      ['Añadidos', last.inserted],
      ['Actualizados', last.updated],
      ['Reactivados', last.reactivated],
      ['Sin cambios', last.unchanged],
      ['Dados de baja', last.deactivated],
    ].filter(([label, value]) => value || label === 'Añadidos' || label === 'Actualizados' || label === 'Sin cambios');
    return h(
      'div.stack',
      h(
        'div.adm-file',
        h('span.adm-file-icon', icon('file-text', { size: 20 })),
        h(
          'div.grow',
          h('div.adm-file-name', { title: last.filename || '' }, last.filename || 'Archivo sin nombre'),
          h(
            'div.small.subtle',
            h('time', { datetime: last.createdAt, title: fmt.absolute(last.createdAt) }, fmt.dateTime(last.createdAt)),
            ` · ${fmt.relative(last.createdAt)}`,
          ),
        ),
      ),
      h('div', tag(IMPORT_MODE_LABELS[last.mode] ?? 'Importación', last.mode === 'replace' ? 'warning' : 'primary')),
      h('dl.dl.adm-dl-counts', rows.map(([label, value]) => [h('dt', label), h('dd.tabular', fmt.number(value ?? 0))])),
    );
  }

  function quickLinks() {
    const item = (iconName, title, text, onClick) =>
      h(
        'li',
        h(
          'button.list-row.adm-quick',
          { type: 'button', onClick },
          h('span.adm-quick-icon', icon(iconName, { size: 18 })),
          h('span.list-row-main', h('span.list-row-title', title), h('span.list-row-sub', text)),
          icon('chevron-right', { size: 18, className: 'icon-chevron' }),
        ),
      );
    return h(
      'ul.list',
      item('plus', 'Nuevo útil', 'Dar de alta un útil a mano', () => env.go('utiles', { create: true })),
      item('user-plus', 'Nuevo operario', 'Añadir a alguien del taller', () => env.go('operarios', { create: true })),
      item('qr-code', 'Conectar móviles', 'Dirección y código QR de la app', () => env.go('ajustes')),
    );
  }

  function renderOnboarding(counts) {
    const hasTools = (counts.tools ?? 0) > 0;
    const hasOperators = (counts.operators ?? 0) > 0;
    onboarding.hidden = hasTools && hasOperators;
    if (onboarding.hidden) {
      clear(onboarding);
      return;
    }
    const step = (done, title, text, action) =>
      h(
        'li.adm-check-item',
        { class: { 'is-done': done } },
        h('span.adm-check-mark', { 'aria-hidden': 'true' }, done ? icon('check', { size: 16, strokeWidth: 2.5 }) : null),
        h('div.grow', h('div.adm-check-title', title, done ? h('span.sr-only', ' (hecho)') : null), h('div.adm-check-text', text)),
        done ? null : action,
      );
    replace(
      onboarding,
      card({
        title: 'Primeros pasos',
        subtitle: 'Deja Nevko listo para el taller en tres pasos.',
        body: h(
          'ol.adm-checklist',
          step(
            hasTools,
            'Importa el catálogo de utillaje',
            'Sube el PDF o CSV con código, ubicación y descripción de cada útil.',
            button({ label: 'Importar', icon: 'upload', size: 'sm', variant: 'primary', href: '#/admin/importar' }),
          ),
          step(
            hasOperators,
            'Da de alta a los operarios',
            'Cada operario elige su nombre al entrar; el PIN es opcional.',
            button({ label: 'Añadir operarios', icon: 'user-plus', size: 'sm', onClick: () => env.go('operarios', { create: true }) }),
          ),
          step(
            false,
            'Conecta los móviles del taller',
            'Escanea el código QR desde cada móvil y añade la app a la pantalla de inicio.',
            button({ label: 'Ver cómo', icon: 'qr-code', size: 'sm', onClick: () => env.go('ajustes') }),
          ),
        ),
      }),
    );
  }

  // Lifecycle ------------------------------------------------------------------------

  return {
    onChange() {
      refreshSoon();
    },
    destroy() {
      destroyed = true;
      refreshSoon.cancel();
      controller?.abort();
    },
  };
}

