// #/lista — "En lista": the tools the operator marked in Buscar ("A la lista"), grouped by
// zone (zones.js) so each zone is walked once: "AR2C4" is "Cajón 4" of "Armario AR2",
// "FB-1-3" is "Módulo 1 · Balda 3" of "Fila FB", "Metrología AM-1 / B4" is "B4" of
// "Metrología AM-1"; a tool inside a kit ("INCLUIDO EN VAT 8015") goes to the kit's zone.
//
// "Cogido" takes one tool: its row stays where it is showing "Cogido" (a second tap never
// lands on the next tool) and the rows taken in a row leave together a moment later, as in
// Guardar. "Coger los N" takes the free tools of a zone and the sticky bar all of them (both
// with confirmation). Every take has "Deshacer" (returns the tools and marks them again).
// "Quitar" unmarks one (with "Deshacer"). Tools someone else took meanwhile turn amber
// (only "Quitar", and the detail for "Me lo ha pasado"); deactivated ones say "Dado de baja".
//
// The list comes from the store (session.refreshPicks keeps it current after every own
// action and every server change), so the tab badge and this screen never disagree.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import {
  button,
  containerHint,
  emptyState,
  errorState,
  skeleton,
  slotLines,
  statusPill,
  tag,
  toolStatus,
  unitTag,
  zoneHead,
} from '../components.js';
import * as fmt from '../fmt.js';
import { reportNotRelisted, takeTool, takeTools } from '../picking.js';
import { router } from '../router.js';
import { addPicks, clearPicks, currentOperator, refreshPicks, removePick } from '../session.js';
import { store } from '../store.js';
import { announce, collapseOut, confirm, liveTime, toast, toastError } from '../ui.js';
import { groupByZone } from '../zones.js';

const TAKEN_HOLD_MS = 1600; // rows marked "Cogido" stay in place this long after the last tap
const MOVE_GUARD_MS = 450; // row taps are ignored this long after the rows move

const isFree = (tool) => toolStatus(tool) === 'available';

export function mountPicklist(root, { direction, restoreScroll }) {
  document.title = 'En lista · Nevko';

  const hiding = new Set(); // ids taken or unmarked here: left out of the list
  const busy = new Set(); // ids whose checkout is running (their row cannot leave yet)
  let animating = 0; // removals in progress: store updates wait until they finish
  let flushTimer = null; // marked rows leave when it fires
  let guardUntil = 0; // performance.now() until which row taps are ignored
  let destroyed = false;
  let signature = null;
  let scrollRestored = direction !== 'back' && direction !== 'forward';

  const title = h('h1.page-title#picklist-title', { tabIndex: -1 }, 'En lista');
  const subtitle = h('p.page-subtitle');
  const header = h('header.page-header', h('div.page-header-text', title, subtitle));
  const content = h('div.picklist-content');

  const clearButton = button({
    label: 'Vaciar la lista',
    icon: 'trash',
    variant: 'ghost',
    className: 'picklist-clear',
    onClick: () => void emptyList(),
  });
  const footer = h('div.picklist-footer', { hidden: true }, clearButton);

  const allButton = button({
    label: 'Coger todos los disponibles',
    icon: 'check-check',
    variant: 'primary',
    size: 'lg',
    block: true,
    className: 'btn-wrap',
    onClick: () => void takeAll(),
  });
  // Outside .view: the view's entrance animation uses a transform, which would
  // make this fixed bar move with it.
  const actionbar = h('div.actionbar', { hidden: true }, h('div.actionbar-inner', allButton));

  root.append(h('div.view', header, content, footer), actionbar);

  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.picks !== previous.picks ||
      state.pickIds !== previous.pickIds ||
      state.picksLoaded !== previous.picksLoaded ||
      state.picksError !== previous.picksError
    ) {
      render();
    }
  });

  render();
  void refreshPicks();

  // Rendering --------------------------------------------------------------------

  function visibleTools() {
    const { picks, pickIds } = store.get();
    return picks.filter((tool) => pickIds.has(tool.id) && !hiding.has(tool.id));
  }

  /** Rows marked "Cogido" / "Quitado" are waiting to leave, or leaving: the list must not move now. */
  function frozen() {
    return animating > 0 || content.querySelector('.stop-item.is-taken, .stop-item.is-removed') !== null;
  }

  function setActionbar(free) {
    const show = free > 1; // a single free tool has its own "Cogido"
    actionbar.hidden = !show;
    document.body.classList.toggle('has-actionbar', show);
    allButton.querySelector('.btn-label').textContent = `Coger todos los disponibles (${free})`;
  }

  /** Title count and sticky bar while marked rows are still shown. */
  function updateCounts() {
    const tools = visibleTools();
    title.textContent = tools.length ? `En lista · ${fmt.tools(tools.length)}` : 'En lista';
    setActionbar(tools.filter(isFree).length);
  }

  function setSubtitle(count, zones) {
    const name = currentOperator()?.name;
    const hint =
      zones > 1
        ? 'Agrupados por zona: coge todos los de una zona antes de pasar a la siguiente.'
        : count === 1
          ? 'Ve a por él a su ubicación.'
          : 'Están todos en la misma zona.';
    subtitle.replaceChildren(...(name ? ['Lista de ', h('strong', name), '. '] : []), hint);
  }

  function render({ force = false } = {}) {
    if (destroyed || (!force && frozen())) return;
    const state = store.get();

    if (!state.picksLoaded) {
      signature = null;
      setActionbar(0);
      title.textContent = 'En lista';
      subtitle.hidden = true;
      footer.hidden = true;
      content.replaceChildren(
        state.picksError
          ? errorState(state.picksError, () => {
              store.set({ picksError: null });
              void refreshPicks();
            })
          : skeleton(3, 'card'),
      );
      return;
    }

    // Tools taken or unmarked here stop being hidden once the list no longer has them.
    const listed = new Set(state.picks.map((tool) => tool.id));
    for (const id of hiding) if (!busy.has(id) && !listed.has(id)) hiding.delete(id);

    const tools = visibleTools();
    const nextSignature = JSON.stringify(
      tools.map((t) => [
        t.id,
        t.code,
        t.location,
        t.description,
        t.active,
        t.holder?.operatorId ?? null,
        t.holder?.since ?? null,
        t.unitIndex,
        t.unitCount,
        t.container,
      ]),
    );
    if (!force && nextSignature === signature) return;
    // The rows move: a tap aimed at one row must not land on the one taking its place.
    if (signature !== null && nextSignature !== signature) guardUntil = performance.now() + MOVE_GUARD_MS;
    signature = nextSignature;

    const count = tools.length;
    const zones = groupByZone(tools);
    title.textContent = count ? `En lista · ${fmt.tools(count)}` : 'En lista';
    subtitle.hidden = count === 0;
    setSubtitle(count, zones.length);
    setActionbar(tools.filter(isFree).length);
    footer.hidden = count === 0;

    if (!count) {
      content.replaceChildren(
        emptyState({
          icon: 'clipboard-list',
          title: 'Tu lista está vacía',
          text: 'Busca un útil y pulsa «A la lista» para preparar tu recorrido.',
          action: button({ label: 'Buscar un útil', icon: 'search', variant: 'primary', href: '#/buscar' }),
        }),
      );
    } else {
      content.replaceChildren(h('ol.route', { 'aria-label': 'Útiles en tu lista, por zona' }, zones.map(zoneCard)));
    }

    if (!scrollRestored) {
      scrollRestored = true;
      restoreScroll?.();
    }
  }

  function zoneCard(group, index) {
    const free = group.tools.filter(isFree);
    const action =
      free.length > 1
        ? button({
            label: `Coger los ${free.length}`,
            icon: 'check-check',
            variant: 'secondary',
            className: 'zone-take',
            attrs: { 'aria-label': `Coger los ${free.length} útiles disponibles de ${group.label}` },
            onClick: () => void takeZone(group),
          })
        : null;
    return h(
      'li.stop',
      { dataset: { key: group.key } },
      zoneHead({ index, zone: group.label, empty: !group.key, count: group.tools.length, action }),
      h('ul.stop-items', group.entries.map(pickItem)),
    );
  }

  /** One listed tool of a zone card (`entry`: groupByZone() entries, with the slot for people). */
  function pickItem(entry) {
    const { tool } = entry;
    const status = toolStatus(tool);
    const item = h('li.stop-item.pick-item', {
      class: { 'is-held': status === 'other', 'is-inactive': status === 'inactive' },
      dataset: { toolId: tool.id },
    });
    const actions = h('div.pick-actions');
    if (status === 'available') {
      actions.append(
        button({
          label: 'Cogido',
          icon: 'check',
          variant: 'primary',
          className: 'pick-take',
          attrs: { 'aria-label': `Cogido: ${tool.code}` },
          onClick: () => void markTaken(tool, item),
        }),
        // Shown instead of the button once taken: same place and size, and not a button.
        h('span.stop-done', { tabIndex: -1 }, icon('check', { size: 20 }), h('span', 'Cogido')),
      );
    }
    actions.append(
      button({
        label: 'Quitar',
        icon: 'x',
        variant: 'ghost',
        className: 'pick-remove',
        attrs: { 'aria-label': `Quitar ${tool.code} de la lista` },
        onClick: () => void unmark(tool, item),
      }),
    );
    item.append(
      h(
        'div.stop-item-main',
        slotLines(tool.location, entry.slotLabel, containerHint(tool)),
        h(
          'div.pick-code-row',
          h('a.stop-item-code', { href: router.href(`/util/${tool.id}`) }, tool.code),
          unitTag(tool),
          // Free (or already mine): the pill; held by someone else / deactivated: the note below.
          status === 'available' || status === 'mine' ? h('span.pick-status', statusPill(tool)) : null,
        ),
        tool.description ? h('div.stop-item-desc', tool.description) : null,
        statusNote(tool, status),
      ),
      actions,
    );
    return item;
  }

  /** Why a listed tool cannot be taken now. */
  function statusNote(tool, status) {
    if (status === 'other') {
      return [
        h(
          'div.pick-held',
          icon('user', { size: 16 }),
          h('span', 'Lo tiene ', h('strong', tool.holder.name), ' · desde ', fmt.clock(tool.holder.since), ' (', liveTime(tool.holder.since, fmt.elapsed), ')'),
        ),
        // The hand-over is confirmed in the detail ("Me lo ha pasado").
        h('a.pick-link', { href: router.href(`/util/${tool.id}`) }, 'Me lo ha pasado', icon('chevron-right', { size: 16 })),
      ];
    }
    if (status === 'inactive') return h('div.pick-note', tag('Dado de baja', 'warning'), h('span', 'Ya no se puede coger.'));
    return null;
  }

  /** After items disappear, keep keyboard focus near where it was. */
  function refocus(index) {
    const buttons = content.querySelectorAll('.pick-take, .pick-remove');
    const target = buttons[Math.min(index, buttons.length - 1)];
    (target ?? title).focus({ preventScroll: true });
  }

  function scheduleFlush(delay = TAKEN_HOLD_MS) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(), delay);
  }

  /**
   * The marked rows leave together (the whole zone card when all its rows are marked) and
   * the list is rendered again.
   */
  async function flush() {
    flushTimer = null;
    if (destroyed || busy.size) return; // the last request schedules it again
    if (animating) {
      scheduleFlush(MOVE_GUARD_MS);
      return;
    }
    const items = Array.from(content.querySelectorAll('.stop-item'));
    const leaving = items.filter((item) => item.matches('.is-taken, .is-removed'));
    if (!leaving.length) {
      render({ force: true });
      return;
    }
    const hadFocus = content.contains(document.activeElement);
    const position = items.indexOf(leaving[0]);
    const targets = new Set(
      leaving.map((item) => {
        const zoneEl = item.closest('.stop');
        const all = Array.from(zoneEl?.querySelectorAll('.stop-item') ?? []);
        return all.length && all.every((el) => el.matches('.is-taken, .is-removed')) ? zoneEl : item;
      }),
    );
    animating += 1;
    await Promise.all([...targets].map((el) => collapseOut(el)));
    animating -= 1;
    render({ force: true });
    if (hadFocus) refocus(position);
  }

  /** After a failed request or an undo: marked rows still leave together; otherwise re-render. */
  function settle() {
    if (destroyed || animating) return;
    if (content.querySelector('.stop-item.is-taken, .stop-item.is-removed')) {
      if (!flushTimer) scheduleFlush();
    } else {
      render({ force: true });
    }
  }

  /** "Deshacer" of a take or of "Quitar": the tools are listed again and come back. */
  function relisted(tools) {
    if (destroyed) return;
    for (const tool of tools) {
      hiding.delete(tool.id);
      content.querySelector(`.stop-item[data-tool-id="${tool.id}"]`)?.classList.remove('is-taken', 'is-removed');
    }
    updateCounts();
    settle();
  }

  // Actions ----------------------------------------------------------------------

  function ignoreTap(tool) {
    return destroyed || hiding.has(tool.id) || animating > 0 || performance.now() < guardUntil;
  }

  async function markTaken(tool, item) {
    if (ignoreTap(tool)) return;
    const hadFocus = item.contains(document.activeElement);
    hiding.add(tool.id);
    busy.add(tool.id);
    clearTimeout(flushTimer); // the marked rows leave once the operator stops marking
    flushTimer = null;
    item.classList.add('is-taken');
    if (hadFocus) item.querySelector('.stop-done')?.focus({ preventScroll: true });
    updateCounts();

    const err = await takeTool(tool, { onUndone: relisted }).then(
      () => null,
      (error) => error,
    );
    busy.delete(tool.id);

    if (!err) {
      if (!destroyed) scheduleFlush();
      return;
    }

    hiding.delete(tool.id);
    if (err.code === 'HELD_BY_OTHER' || err.code === 'TOOL_INACTIVE' || err.status === 404) {
      toast(err.message, { type: 'warning' }); // the row shows the new state after the refresh
    } else {
      toastError(err);
    }
    if (!destroyed) {
      const doneHadFocus = item.contains(document.activeElement);
      item.classList.remove('is-taken');
      if (doneHadFocus) item.querySelector('.pick-take')?.focus({ preventScroll: true });
      updateCounts();
    }
    await refreshPicks();
    settle();
  }

  /** "Quitar": the row leaves at once (with "Deshacer"). */
  async function unmark(tool, item) {
    if (ignoreTap(tool)) return;
    const operatorId = currentOperator()?.id ?? null;
    hiding.add(tool.id);
    item.classList.add('is-removed');
    updateCounts();
    clearTimeout(flushTimer);
    void flush(); // rows marked "Cogido" meanwhile leave with it
    try {
      await removePick(tool.id);
    } catch (err) {
      hiding.delete(tool.id);
      toastError(err);
      settle();
      return;
    }
    toast(`${tool.code} quitado de tu lista`, {
      action: { label: 'Deshacer', onClick: () => void relist([tool], operatorId) },
    });
    announce(`${tool.code} quitado de tu lista`);
  }

  async function relist(tools, operatorId) {
    if (store.get().operator?.id !== operatorId) {
      toast('No se puede deshacer: ha cambiado el operario.', { type: 'warning' });
      return;
    }
    try {
      const result = await addPicks(tools.map((tool) => tool.id));
      relisted(tools);
      reportNotRelisted(result?.skipped); // e.g. deactivated meanwhile
    } catch (err) {
      toastError(err);
    }
  }

  /** List of the codes (by zone) shown in the confirmation of a batch take. */
  function codesList(tools) {
    return h(
      'ul.pick-confirm',
      groupByZone(tools).map((group) =>
        h(
          'li',
          h('span.pick-confirm-zone', group.key ? fmt.keepHyphens(group.label) : 'Sin ubicación asignada'),
          h('span.pick-confirm-codes', group.tools.map(fmt.codeWithUnit).join(', ')),
        ),
      ),
    );
  }

  /** Confirms and takes several tools at once; the rows taken leave together. */
  async function takeMany(tools, { title: dialogTitle, confirmLabel }) {
    if (!tools.length || destroyed || animating) return;
    const name = currentOperator()?.name;
    let result = null;
    const ok = await confirm({
      title: dialogTitle,
      icon: 'check-check',
      message: h(
        'div.stack.stack-sm',
        h('p', name ? ['Se pondrán a nombre de ', h('strong', name), ':'] : 'Se pondrán a tu nombre:'),
        codesList(tools),
      ),
      confirmLabel,
      onConfirm: async () => {
        try {
          result = await takeTools(tools, { onUndone: relisted });
        } catch (err) {
          toastError(err);
          return false; // keep the dialog open
        }
        return true;
      },
    });
    if (!ok || !result || destroyed) return;

    const takenIds = new Set(result.taken.map((tool) => tool.id));
    for (const id of takenIds) hiding.add(id);
    for (const el of content.querySelectorAll('.stop-item')) {
      if (takenIds.has(Number(el.dataset.toolId))) el.classList.add('is-taken');
    }
    clearTimeout(flushTimer);
    await flush();
    title.focus({ preventScroll: true });
    if (takenIds.size) announce(`${fmt.tools(takenIds.size)} cogidos`);
    await refreshPicks();
    render();
  }

  function takeZone(group) {
    const free = visibleTools().filter((tool) => isFree(tool) && group.tools.some((t) => t.id === tool.id));
    return takeMany(free, {
      title: `¿Coger los ${free.length} de ${group.key ? group.label : 'sin ubicación'}?`,
      confirmLabel: `Coger los ${free.length}`,
    });
  }

  function takeAll() {
    const free = visibleTools().filter(isFree);
    return takeMany(free, {
      title: free.length === 1 ? '¿Coger el útil disponible?' : `¿Coger los ${free.length} útiles disponibles?`,
      confirmLabel: `Coger todos (${free.length})`,
    });
  }

  async function emptyList() {
    const tools = visibleTools();
    if (!tools.length || destroyed) return;
    const operatorId = currentOperator()?.id ?? null;
    const ok = await confirm({
      title: '¿Vaciar tu lista?',
      icon: 'trash',
      danger: true,
      message:
        tools.length === 1
          ? `Se quita ${tools[0].code} de tu lista. No se coge ni se devuelve nada.`
          : `Se quitan los ${tools.length} útiles de tu lista. No se coge ni se devuelve nada.`,
      confirmLabel: 'Vaciar la lista',
      onConfirm: async () => {
        try {
          await clearPicks();
        } catch (err) {
          toastError(err);
          return false;
        }
        return true;
      },
    });
    if (!ok) return;
    toast(tools.length === 1 ? 'Lista vaciada: 1 útil quitado' : `Lista vaciada: ${fmt.tools(tools.length)} quitados`, {
      action: { label: 'Deshacer', onClick: () => void relist(tools, operatorId) },
    });
    if (!destroyed) title.focus({ preventScroll: true });
  }

  // Lifecycle --------------------------------------------------------------------

  return {
    /** En lista tab tapped while already here: back to the top. */
    reselect() {
      window.scrollTo({ top: 0 });
      title.focus({ preventScroll: true });
    },
    focusTitle() {
      title.focus({ preventScroll: true });
    },
    destroy() {
      destroyed = true;
      clearTimeout(flushTimer);
      unsubscribe();
      document.body.classList.remove('has-actionbar');
    },
  };
}
