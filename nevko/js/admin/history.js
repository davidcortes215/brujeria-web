// #/admin/historial — every checkout, most recent first: tool (code + location),
// operator, taken, returned, duration and how it ended (Devuelto / Traspasado a X /
// Forzado por admin / En uso). Text filter (code, location or operator), operator
// filter and pagination. Other sections can open it pre-filtered (env.go intent).
// Live updates (SSE) reload the first page only while no text filter is active (a text
// search is heavier on the server); with one, a notice offers to refresh by hand.

import { avatar, button, emptyState, pill, tag, unitTag } from '../components.js';
import { clear, h, replace } from '../dom.js';
import * as fmt from '../fmt.js';
import { icon } from '../icons.js';
import * as ui from '../ui.js';
import {
  adminRequest,
  dataTable,
  dateTimeCell,
  debounce,
  inlineError,
  liveDuration,
  pageHeader,
  pagination,
  tableSkeleton,
} from './common.js';

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;
const REFRESH_DELAY_MS = 400;

/** How a checkout ended, as a small badge. */
export function returnBadge(item) {
  if (!item.returnedAt) return pill('other', 'En uso');
  switch (item.returnType) {
    case 'transferred':
      return tag(item.closedByName ? `Traspasado a ${item.closedByName}` : 'Traspasado', 'primary');
    case 'forced':
      return tag('Forzado por admin', 'warning');
    default:
      return tag('Devuelto', 'success');
  }
}

export function mountHistory(root, env) {
  const state = env.store;
  state.q ??= '';
  state.operatorId ??= '';
  state.offset ??= 0;
  const intent = state.intent;
  state.intent = null;
  if (intent) {
    state.q = intent.q ?? '';
    state.operatorId = intent.operatorId ? String(intent.operatorId) : '';
    state.offset = 0;
  }

  let data = null;
  let error = null;
  let operators = null;
  let controller = null;
  let destroyed = false;

  const header = pageHeader({
    title: 'Historial',
    subtitle: 'Quién ha usado cada útil y cuándo, del más reciente al más antiguo.',
  });

  const search = h('input.input', {
    type: 'search',
    value: state.q,
    placeholder: 'Código, ubicación u operario',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-label': 'Buscar en el historial',
    onInput: () => searchSoon(),
    onKeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchSoon.cancel();
        applySearch();
      }
    },
  });
  const operatorSelect = h('select.select.adm-select-operator', {
    'aria-label': 'Filtrar por operario',
    onChange: () => {
      state.operatorId = operatorSelect.value;
      state.offset = 0;
      void load();
    },
  });
  const clearButton = h(
    'button.btn.btn-ghost.adm-clear-filters',
    { type: 'button', hidden: true, onClick: () => clearFilters() },
    icon('x', { size: 18 }),
    h('span.btn-label', 'Quitar filtros'),
  );

  const staleNotice = h(
    'div.adm-stale',
    { hidden: true, role: 'status' },
    icon('info', { size: 16 }),
    h('span.grow', 'Ha habido cambios desde que hiciste esta búsqueda.'),
    button({ label: 'Actualizar', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => void load() }),
  );
  const results = h('div.adm-results');
  const pager = h('div');
  root.append(
    header.el,
    h('div.toolbar.adm-toolbar', h('div.toolbar-grow.input-group', icon('search'), search), operatorSelect, clearButton),
    staleNotice,
    results,
    pager,
  );

  const searchSoon = debounce(applySearch, SEARCH_DELAY_MS);
  const refreshSoon = debounce(() => void load({ silent: true }), REFRESH_DELAY_MS);
  const refreshOperatorsSoon = debounce(() => void loadOperators(), REFRESH_DELAY_MS);

  renderOperators();
  render();
  void loadOperators();
  void load();

  // Data --------------------------------------------------------------------------

  function applySearch() {
    const q = search.value.trim();
    if (q === state.q.trim()) return;
    state.q = q;
    state.offset = 0;
    void load();
  }

  function clearFilters() {
    search.value = '';
    state.q = '';
    state.operatorId = '';
    state.offset = 0;
    renderOperators();
    void load();
    search.focus();
  }

  async function loadOperators() {
    try {
      const result = await adminRequest('GET', '/admin/operators');
      if (destroyed) return;
      operators = Array.isArray(result?.operators) ? result.operators : [];
      renderOperators();
    } catch (err) {
      if (!destroyed && operators === null) operators = [];
    }
  }

  async function load({ silent = false } = {}) {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    staleNotice.hidden = true;
    syncClearButton();
    if (!silent) results.classList.add('is-busy');
    try {
      const result = await adminRequest('GET', '/admin/history', {
        query: { q: state.q.trim(), operatorId: state.operatorId, offset: state.offset, limit: PAGE_SIZE },
        signal: mine.signal,
      });
      if (destroyed || controller !== mine) return;
      const items = Array.isArray(result?.items) ? result.items : [];
      if (items.length === 0 && result.total > 0 && state.offset > 0) {
        state.offset = Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE;
        void load({ silent });
        return;
      }
      data = { total: Number(result?.total) || 0, items };
      error = null;
    } catch (err) {
      if (destroyed || controller !== mine || err.code === 'ABORTED' || err.status === 401) return;
      if (silent && data) return;
      if (err.code === 'VALIDATION' && state.operatorId) {
        // The operator filter no longer exists: drop it.
        state.operatorId = '';
        renderOperators();
        void load();
        return;
      }
      error = err;
    } finally {
      if (controller === mine) results.classList.remove('is-busy');
    }
    render();
  }

  // Rendering -------------------------------------------------------------------------

  function syncClearButton() {
    clearButton.hidden = !state.q.trim() && !state.operatorId;
  }

  function renderOperators() {
    const list = operators ?? [];
    const active = list.filter((op) => op.active);
    const inactive = list.filter((op) => !op.active);
    const option = (op) => h('option', { value: String(op.id) }, op.name);
    replace(
      operatorSelect,
      h('option', { value: '' }, 'Todos los operarios'),
      active.length ? h('optgroup', { label: 'Activos' }, active.map(option)) : null,
      inactive.length ? h('optgroup', { label: 'Desactivados' }, inactive.map(option)) : null,
    );
    // Keep a pre-selected operator even before the list arrives.
    if (state.operatorId && !list.some((op) => String(op.id) === state.operatorId)) {
      operatorSelect.append(h('option', { value: state.operatorId }, operators ? 'Operario desconocido' : 'Cargando…'));
    }
    operatorSelect.value = state.operatorId;
    syncClearButton();
  }

  function render() {
    if (destroyed) return;
    results.setAttribute('aria-busy', String(!data && !error));
    if (!data) {
      replace(results, h('div.card', error ? inlineError(error, retry) : tableSkeleton(8, 5)));
      clear(pager);
      return;
    }
    const { total, items } = data;
    if (total === 0) {
      const filtered = Boolean(state.q.trim() || state.operatorId);
      replace(
        results,
        h(
          'div.card',
          emptyState({
            icon: filtered ? 'search-x' : 'history',
            title: filtered ? 'No hay movimientos con estos filtros' : 'Todavía no hay movimientos',
            text: filtered
              ? 'Prueba con otra búsqueda u otro operario.'
              : 'Cada vez que un operario use un útil quedará registrado aquí.',
            compact: true,
          }),
        ),
      );
      clear(pager);
      return;
    }
    replace(results, h('div.table-wrap', historyTable(items)));
    replace(
      pager,
      pagination({
        offset: state.offset,
        limit: PAGE_SIZE,
        total,
        onChange: (offset) => {
          state.offset = offset;
          void load();
          header.title.scrollIntoView({ block: 'start', behavior: ui.prefersReducedMotion() ? 'auto' : 'smooth' });
        },
      }),
    );
  }

  function retry() {
    error = null;
    render();
    void load();
  }

  function historyTable(items) {
    return dataTable({
      caption: 'Historial de movimientos',
      rows: items,
      columns: [
        {
          label: 'Útil',
          primary: true,
          className: 'adm-col-tool',
          cell: (item) =>
            h(
              'div.adm-tool-cell',
              h('span.adm-code', item.tool?.code ?? ''),
              item.tool ? unitTag(item.tool) : null,
              item.tool?.location ? h('span.adm-cell-sub.is-wrap', { title: item.tool.location }, item.tool.location) : null,
            ),
        },
        {
          label: 'Operario',
          cell: (item) =>
            h('span.adm-person', avatar(item.operator?.name ?? '?', { size: 'sm' }), h('span.adm-person-name', item.operator?.name ?? '')),
        },
        { label: 'Cogido', className: 'cell-nowrap', cell: (item) => dateTimeCell(item.takenAt) },
        { label: 'Devuelto', className: 'cell-nowrap', cell: (item) => dateTimeCell(item.returnedAt) },
        {
          label: 'Duración',
          className: 'cell-nowrap',
          cell: (item) =>
            item.returnedAt
              ? h('span.tabular', fmt.duration(fmt.toDate(item.returnedAt) - fmt.toDate(item.takenAt)))
              : liveDuration(item.takenAt),
        },
        { label: 'Tipo', cell: (item) => returnBadge(item) },
      ],
    });
  }

  // Lifecycle ------------------------------------------------------------------------------

  return {
    onChange(event) {
      if (event.type === 'operators' || event.type === 'resync') refreshOperatorsSoon();
      // Only the first page follows live changes: later pages would shift under the reader.
      if (state.offset !== 0 && event.type !== 'resync') return;
      if (state.q.trim()) {
        // No automatic text searches: offer a manual refresh instead.
        if (data && !error) staleNotice.hidden = false;
        return;
      }
      refreshSoon();
    },
    destroy() {
      destroyed = true;
      searchSoon.cancel();
      refreshSoon.cancel();
      refreshOperatorsSoon.cancel();
      controller?.abort();
    },
  };
}
