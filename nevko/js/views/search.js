// #/buscar — big search field with live results (SPEC §7).
//
// Enter opens the exact code match, or the only result (a code with several units stays on
// the list: each unit is its own row, "Unidad 2 de 3", with its own location, status and
// actions). The last query and its
// results are kept in the store, so coming back from a detail shows them instantly.
//
// Available tools can be handled from the list itself (tapping the card still opens the
// detail): "A la lista" marks them for En lista (tapping "En la lista" unmarks) and
// "Coger" takes them at once. After "Coger" the row keeps its size and shows "Cogido", so
// the rows below never move under the finger; row actions are also ignored for a moment
// after the list changes. The field keeps its text and results, so several tools can be
// handled in a row. With a non-empty pick list, a bar above the tab bar leads to En lista.

import { api } from '../api.js';
import { h, highlight, replace } from '../dom.js';
import { icon } from '../icons.js';
import { button, containerHint, emptyState, errorState, iconButton, skeleton, statusPill, toolStatus, unitTag } from '../components.js';
import * as fmt from '../fmt.js';
import { cleanText, codeLoose, codeNorm, matchesLoose } from '../normalize.js';
import { takeTool, togglePick } from '../picking.js';
import { router } from '../router.js';
import { canScan, scanCode } from '../scanner.js';
import { isPickPending } from '../session.js';
import { setSearch, store } from '../store.js';
import { announce, setBusy, toast, toastError } from '../ui.js';

const DEBOUNCE_MS = 150;
const SKELETON_DELAY_MS = 180;
const LIMIT = 30;
const LIVE_REFRESH_TYPES = new Set(['resync', 'import', 'tools', 'operators']);
const MOVE_GUARD_MS = 450; // row actions are ignored this long after the rows change
const TOGGLE_LOCK_MS = 600; // a second tap on "A la lista" this soon is a double tap
const BAR_GUARD_MS = 500; // the "Ir a por ellos" bar ignores taps this long after appearing

export function mountSearch(root, { direction, restoreScroll }) {
  document.title = 'Buscar · Nevko';

  const saved = store.get().search;
  let result = saved.result && cleanText(saved.query) === saved.result.q ? saved.result : null; // { q, data }
  let controller = null;
  let seq = 0;
  let debounceTimer = null;
  let skeletonTimer = null;
  let liveTimer = null;
  let mode = 'idle'; // idle | loading | results | error
  let destroyed = false;
  let shown = null; // { q, ids } of the rows on screen (patched in place while the same)
  let guardUntil = 0; // performance.now() until which row actions are ignored
  let barShownAt = 0;
  const taken = new Set(); // ids taken from this list: their row shows "Cogido" (same query)
  const taking = new Set(); // ids whose "Coger" request is running
  const toggledAt = new Map(); // id -> performance.now() of the last "A la lista" tap

  const input = h('input.search-input#search-input', {
    type: 'search',
    value: saved.query,
    placeholder: 'Código del útil',
    autocomplete: 'off',
    autocapitalize: 'characters',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    inputmode: 'text',
    maxlength: 120,
    'aria-label': 'Buscar útil por código, descripción o ubicación',
    'aria-controls': 'search-results',
    'aria-describedby': 'search-meta',
    onInput,
  });
  const clearButton = iconButton({ icon: 'x', label: 'Borrar búsqueda', className: 'search-clear', onClick: clearQuery });
  clearButton.hidden = !saved.query;

  const scanButton = canScan()
    ? button({ icon: 'scan', label: 'Escanear código', iconOnly: true, variant: 'secondary', className: 'search-scan', onClick: scan })
    : null;

  const form = h(
    'form.search-bar',
    {
      role: 'search',
      action: '#',
      onSubmit: (event) => {
        event.preventDefault();
        void openBest();
      },
    },
    h('div.search', icon('search', { size: 22 }), input, clearButton),
    scanButton,
  );
  const meta = h('div.search-meta#search-meta');
  const content = h('div#search-results');

  // "N en tu lista · Ir a por ellos". Outside .view: the view's entrance animation uses a
  // transform, which would make this fixed bar move with it.
  const barLink = button({
    label: 'Ir a por ellos',
    iconRight: 'arrow-right',
    variant: 'primary',
    size: 'lg',
    block: true,
    href: '#/lista',
    className: 'pick-bar-link',
    onClick: (event) => {
      // Just appeared where the finger was (e.g. after "A la lista" low on the screen).
      if (performance.now() - barShownAt < BAR_GUARD_MS) event.preventDefault();
    },
  });
  const bar = h('div.actionbar.pick-bar', { hidden: true }, h('div.actionbar-inner', barLink));

  root.append(h('div.view', h('h1.sr-only', 'Buscar útil'), form, meta, content), bar);

  const unsubscribers = [
    store.select(
      (state) => state.inUseCount,
      () => {
        if (mode === 'idle') renderIdle();
      },
      { immediate: false },
    ),
    store.select((state) => state.pickIds, syncListButtons, { immediate: false }),
    store.select((state) => state.pickCount, updateBar),
  ];

  // Initial render -------------------------------------------------------------
  const query = cleanText(saved.query);
  if (!query) renderIdle();
  else if (result) {
    renderResults();
    if (direction === 'back' || direction === 'forward') restoreScroll();
    void runSearch(query, { silent: true }); // refresh statuses in the background
  } else {
    void runSearch(query);
  }

  if (saved.focus || !query) {
    input.focus({ preventScroll: true });
    setSearch({ focus: false });
  }

  // Behaviour ------------------------------------------------------------------

  function onInput() {
    const value = input.value;
    clearButton.hidden = !value;
    setSearch({ query: value });
    clearTimeout(debounceTimer);
    const q = cleanText(value);
    if (!q) {
      cancelPending();
      result = null;
      setSearch({ result: null });
      renderIdle();
      return;
    }
    debounceTimer = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
  }

  function cancelPending() {
    controller?.abort();
    controller = null;
    seq += 1;
    clearTimeout(skeletonTimer);
  }

  function clearQuery() {
    input.value = '';
    onInput();
    input.focus();
  }

  /**
   * Fetches results for `q`. Resolves with { q, data } or null (superseded / failed).
   * silent: keep what is on screen while loading and do not show errors.
   */
  async function runSearch(q, { silent = false } = {}) {
    clearTimeout(debounceTimer);
    cancelPending();
    const mySeq = seq;
    const signal = (controller = new AbortController()).signal;
    if (!silent) {
      if (mode === 'results') meta.textContent = 'Buscando…';
      else skeletonTimer = setTimeout(() => mySeq === seq && renderLoading(), SKELETON_DELAY_MS);
    }
    try {
      const data = await api.search(q, { limit: LIMIT, signal });
      if (destroyed || mySeq !== seq) return null;
      result = { q, data };
      setSearch({ result });
      renderResults();
      return result;
    } catch (err) {
      if (destroyed || mySeq !== seq || err.code === 'ABORTED') return null;
      if (!silent || mode !== 'results') renderError(err, q);
      return null;
    } finally {
      if (mySeq === seq) clearTimeout(skeletonTimer);
    }
  }

  /** Refreshes the statuses of the rows on screen (after an action or a server change). */
  function refreshSoon() {
    if (!result || mode !== 'results') return;
    clearTimeout(liveTimer);
    const q = result.q;
    liveTimer = setTimeout(() => {
      if (!destroyed && cleanText(input.value) === q) void runSearch(q, { silent: true });
    }, DEBOUNCE_MS);
  }

  /** Enter / scan: open the exact code match (when it has one unit), or the only result. */
  async function openBest() {
    const q = cleanText(input.value);
    if (!q) return;
    const current = result && result.q === q ? result : await runSearch(q);
    if (!current || destroyed) return;
    const wanted = codeNorm(q);
    const tools = current.data.tools;
    const exactUnits = wanted ? tools.filter((tool) => codeNorm(tool.code) === wanted) : [];
    // Several units of that code: the operator chooses one in the list.
    let exact = exactUnits.length === 1 ? exactUnits[0] : null;
    if (!exactUnits.length && matchesLoose(q)) {
      // "ut 12" for UT-0012 (the server ignores zero padding): only when it is the only such code.
      const loose = tools.filter((tool) => codeLoose(tool.code) === wanted);
      if (loose.length === 1) exact = loose[0];
    }
    const target = exact ?? (current.data.total === 1 ? tools[0] : null);
    input.blur(); // hide the keyboard so the results (or the detail) are visible
    if (target) router.navigate(`/util/${target.id}`);
  }

  async function scan() {
    const code = await scanCode();
    if (!code || destroyed) return;
    input.value = code;
    onInput();
    await openBest();
  }

  // Row actions ------------------------------------------------------------------

  /** Taps landing right after the rows changed were aimed at what was there before. */
  function guarded() {
    return destroyed || performance.now() < guardUntil;
  }

  /** "A la lista" / "En la lista": marks or unmarks the tool (the button changes at once). */
  async function toggleList(tool) {
    const now = performance.now();
    if (guarded() || isPickPending(tool.id) || now - (toggledAt.get(tool.id) ?? -Infinity) < TOGGLE_LOCK_MS) return;
    toggledAt.set(tool.id, now);
    const listed = await togglePick(tool);
    if (listed === true) announce(`${tool.code} añadido a tu lista`);
    else if (listed === false) announce(`${tool.code} quitado de tu lista`);
    else refreshSoon(); // refused (e.g. someone took it meanwhile): show its status now
  }

  /** "Coger": takes the tool now; its row stays in place showing "Cogido". */
  async function take(tool) {
    if (guarded() || taking.has(tool.id) || taken.has(tool.id)) return;
    taking.add(tool.id);
    setTakeBusy(tool.id, true);
    try {
      const updated = await takeTool(tool, { onUndone: (tools) => !destroyed && untake(tools) });
      taking.delete(tool.id);
      if (destroyed) return;
      taken.add(tool.id);
      updateTool({ ...tool, ...updated });
      announce(`${tool.code} cogido`);
    } catch (err) {
      taking.delete(tool.id);
      if (destroyed) return;
      setTakeBusy(tool.id, false);
      if (err.code === 'HELD_BY_OTHER' || err.code === 'TOOL_INACTIVE' || err.status === 404) {
        toast(err.message, { type: 'warning' });
        refreshSoon();
      } else {
        toastError(err);
      }
    }
  }

  /** After "Deshacer" of a "Coger": the rows show the tools free again (with their actions). */
  function untake(tools) {
    for (const tool of tools) {
      taken.delete(tool.id);
      updateTool({ ...tool, holder: null });
    }
    refreshSoon();
  }

  function rowOf(id) {
    return content.querySelector(`.result-card[data-tool-id="${id}"]`);
  }

  function setTakeBusy(id, busy) {
    const takeButton = rowOf(id)?.querySelector('.result-take');
    if (takeButton) setBusy(takeButton, busy);
  }

  /** Replaces one tool of the current results and redraws its row in place. */
  function updateTool(next) {
    if (!result) return;
    const tools = result.data.tools.map((tool) => (tool.id === next.id ? { ...tool, ...next } : tool));
    result = { ...result, data: { ...result.data, tools } };
    setSearch({ result });
    const old = rowOf(next.id);
    if (!old) return;
    const { q } = result;
    const row = resultItem(tools.find((tool) => tool.id === next.id), q, codeNorm(q), matchesLoose(q));
    const hadFocus = old.contains(document.activeElement);
    old.replaceWith(row);
    // Keyboard focus stays on the row (on "Cogido" once taken).
    if (hadFocus) (row.querySelector('.result-done:not([hidden])') ?? row.querySelector('.result'))?.focus({ preventScroll: true });
  }

  /** The pick list changed (here, on another device or by the server): relabel the buttons. */
  function syncListButtons(pickIds) {
    for (const listButton of content.querySelectorAll('.result-list')) {
      const row = listButton.closest('.result-card');
      const id = Number(row?.dataset.toolId);
      const code = row?.dataset.code ?? '';
      setListState(listButton, code, pickIds.has(id));
    }
  }

  function setListState(listButton, code, listed) {
    if (listButton.classList.contains('is-on') === listed && listButton.childElementCount) return;
    listButton.classList.toggle('is-on', listed);
    listButton.replaceChildren(icon(listed ? 'list-check' : 'list-plus'), h('span.btn-label', listed ? 'En la lista' : 'A la lista'));
    listButton.setAttribute('aria-label', listed ? `${code} está en tu lista. Quitar de la lista` : `Añadir ${code} a tu lista`);
  }

  function updateBar(count) {
    const show = count > 0;
    if (show && bar.hidden) barShownAt = performance.now();
    bar.hidden = !show;
    document.body.classList.toggle('has-actionbar', show);
    if (!show) return;
    barLink.querySelector('.btn-label').textContent = `${count} en tu lista · Ir a por ellos`;
    barLink.setAttribute('aria-label', `${fmt.tools(count)} en tu lista. Ir a por ellos`);
  }

  // Rendering ------------------------------------------------------------------

  function renderIdle() {
    mode = 'idle';
    shown = null;
    taken.clear();
    meta.textContent = '';
    const count = store.get().inUseCount;
    replace(
      content,
      count
        ? h(
            'a.quick-link',
            { href: '#/guardar' },
            icon('archive', { size: 22 }),
            h(
              'div.quick-link-text',
              `Tienes ${fmt.tools(count)} en uso`,
              h('div.quick-link-sub', count === 1 ? 'Mira dónde va en Guardar' : 'Mira dónde van en Guardar'),
            ),
            icon('chevron-right'),
          )
        : null,
      emptyState({
        icon: 'search',
        title: 'Escribe el código del útil',
        text: 'Verás su ubicación asignada y si lo está usando otro operario. También puedes buscar por descripción o ubicación.',
      }),
    );
  }

  function renderLoading() {
    mode = 'loading';
    shown = null;
    meta.textContent = 'Buscando…';
    content.replaceChildren(skeleton(4, 'result'));
  }

  function renderError(err, q) {
    mode = 'error';
    shown = null;
    meta.textContent = '';
    content.replaceChildren(errorState(err, () => void runSearch(q), { title: 'No se ha podido buscar' }));
  }

  function renderResults() {
    const wasShowing = mode === 'results' && shown !== null;
    mode = 'results';
    const { q, data } = result;
    const tools = data.tools ?? [];
    if (!shown || shown.q !== q) taken.clear(); // "Cogido" rows belong to the query they were taken in
    if (!tools.length) {
      shown = null;
      meta.textContent = '';
      content.replaceChildren(
        emptyState({
          icon: 'search-x',
          title: `No hay ningún útil con «${q}»`,
          text: 'Comprueba el código o prueba con parte de la descripción o de la ubicación.',
        }),
      );
      announce(`No hay ningún útil con ${q}`);
      return;
    }
    const total = data.total ?? tools.length;
    replace(
      meta,
      h('span', total > tools.length ? `${tools.length} de ${fmt.number(total)} resultados` : fmt.count(total, 'resultado', 'resultados')),
      total > tools.length ? h('span', 'Escribe más para afinar') : null,
    );
    const wanted = codeNorm(q);
    const loose = matchesLoose(q);
    const ids = tools.map((tool) => tool.id).join(',');
    const list = content.querySelector('ul.results');

    if (wasShowing && shown.q === q && shown.ids === ids && list) {
      // Same rows (a background refresh): redraw only the ones that changed.
      let changed = false;
      for (const tool of tools) {
        const old = rowOf(tool.id);
        const row = resultItem(tool, q, wanted, loose);
        if (old && old.dataset.state === row.dataset.state) continue;
        changed = true;
        const hadFocus = old?.contains(document.activeElement);
        if (old) old.replaceWith(row);
        if (hadFocus) row.querySelector('.result')?.focus({ preventScroll: true });
      }
      if (changed) guardUntil = performance.now() + MOVE_GUARD_MS;
      return;
    }

    // The rows move: a tap aimed at one row must not land on the one taking its place.
    if (wasShowing) guardUntil = performance.now() + MOVE_GUARD_MS;
    shown = { q, ids };
    content.replaceChildren(h('ul.results', tools.map((tool) => resultItem(tool, q, wanted, loose))));
    announce(fmt.count(total, 'resultado', 'resultados'));
  }

  function resultItem(tool, q, wanted, loose) {
    // Matched by its code, also without zero padding ("ut 12" -> UT-0012): mark the code only.
    const codeMatched =
      Boolean(wanted) && (codeNorm(tool.code).includes(wanted) || (loose && codeLoose(tool.code).includes(wanted)));
    const location = tool.location ? fmt.keepHyphens(tool.location) : '';
    const status = toolStatus(tool);
    if (taken.has(tool.id) && status !== 'mine') taken.delete(tool.id); // returned meanwhile
    const isTaken = taken.has(tool.id);
    const busy = taking.has(tool.id);
    const actionable = status === 'available' || isTaken || busy;

    const link = h(
      'a.result',
      { href: router.href(`/util/${tool.id}`) },
      h('span.result-code', h('span', codeMatched ? highlight(tool.code, q, { mode: 'code' }) : tool.code), unitTag(tool)),
      h('span.result-status', statusPill(tool)),
      h(
        'span.result-loc',
        { class: { 'is-empty': !tool.location } },
        icon('map-pin', { size: 17 }),
        h(
          'span',
          location ? (codeMatched ? location : highlight(location, q, { mode: 'text' })) : 'Sin ubicación asignada',
          location ? containerHint(tool) : null,
        ),
      ),
      tool.description
        ? h('span.result-desc', codeMatched ? tool.description : highlight(tool.description, q, { mode: 'text' }))
        : null,
    );
    const row = h(
      'li.result-card',
      {
        class: { 'is-taken': isTaken },
        dataset: {
          toolId: tool.id,
          code: tool.code,
          // What the row shows: a background refresh redraws it only when this changes.
          state: JSON.stringify([
            tool.code,
            tool.location,
            tool.description,
            status,
            tool.holder?.name ?? null,
            isTaken,
            busy,
            fmt.unitLabel(tool),
            fmt.containerPlaces(tool.container),
          ]),
        },
      },
      link,
    );
    if (actionable) row.append(actionsOf(tool, { isTaken, busy }));
    return row;
  }

  function actionsOf(tool, { isTaken, busy }) {
    const listButton = h('button.btn.btn-secondary.result-list', { type: 'button', onClick: () => void toggleList(tool) });
    setListState(listButton, tool.code, store.get().pickIds.has(tool.id));
    const takeButton = button({
      label: 'Coger',
      icon: 'check',
      variant: 'primary',
      className: 'result-take',
      attrs: { 'aria-label': `Coger ${tool.code}` },
      onClick: () => void take(tool),
    });
    if (busy) setBusy(takeButton, true);
    // Shown instead of both buttons once taken: same place and height, and not a button.
    const done = h('span.result-done', { tabIndex: -1, hidden: !isTaken }, icon('check', { size: 20 }), h('span', 'Cogido'));
    listButton.hidden = isTaken;
    takeButton.hidden = isTaken;
    return h('div.result-actions', listButton, takeButton, done);
  }

  // Lifecycle --------------------------------------------------------------------

  return {
    /** Server change: refresh the visible results when they may be affected. */
    onChange(event) {
      if (event.type === 'picklist') return; // only the marks change: they come from the store
      if (mode === 'error') {
        // The search failed (e.g. no connection): any server event means it can be retried now.
        const q = cleanText(input.value);
        clearTimeout(liveTimer);
        if (q) {
          liveTimer = setTimeout(() => {
            if (!destroyed && mode === 'error' && cleanText(input.value) === q) void runSearch(q);
          }, DEBOUNCE_MS);
        }
        return;
      }
      if (!result || mode !== 'results') return;
      const ids = new Set(result.data.tools.map((tool) => tool.id));
      const affected = LIVE_REFRESH_TYPES.has(event.type) || !event.toolIds.length || event.toolIds.some((id) => ids.has(id));
      if (affected) refreshSoon();
    },
    /** The Buscar tab was tapped while already here: back to the field. */
    reselect() {
      window.scrollTo({ top: 0 });
      input.focus();
      input.select();
    },
    destroy() {
      destroyed = true;
      cancelPending();
      clearTimeout(debounceTimer);
      clearTimeout(liveTimer);
      unsubscribers.forEach((fn) => fn());
      document.body.classList.remove('has-actionbar');
    },
  };
}
