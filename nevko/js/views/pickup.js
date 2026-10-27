// #/guardar — "Guardar", the put-away route (SPEC §7): the tools the operator holds, grouped by zone
// (zones.js: "AR2C4" is "Cajón 4" of "Armario AR2", "FB-1-3" is "Módulo 1 · Balda 3" of
// "Fila FB", "Metrología AM-1 / B4" is "B4" of "Metrología AM-1"; a tool inside a kit goes to
// the kit's zone, "en VAT 8015"), so each zone is walked once. "Guardado" returns one tool: its row stays where it is showing "Guardado" (a
// second tap never lands on the next tool), and the rows marked in a row leave together a
// moment later. The toast offers "Deshacer"; the sticky bar returns them all.
//
// The list comes from the store (session.refreshMine keeps it current after every own
// action and every server change), so the tab badge and this screen never disagree.

import { api } from '../api.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { button, containerHint, emptyState, errorState, skeleton, slotLines, unitTag, zoneHead } from '../components.js';
import * as fmt from '../fmt.js';
import { router } from '../router.js';
import { cancelExpectedRemoval, currentOperator, expectRemoval, refreshMine } from '../session.js';
import { store } from '../store.js';
import { announce, collapseOut, confirm, liveTime, toast, toastError } from '../ui.js';
import { groupByZone } from '../zones.js';

const STORED_HOLD_MS = 1600; // marked rows stay in place this long after the last "Guardado"
const MOVE_GUARD_MS = 450; // "Guardado" taps are ignored this long after the rows move

/** "UT-0012 marcado como guardado por Juan Pérez" / "3 útiles marcados como guardados por …". */
function storedText(tools, name) {
  const text = tools.length === 1 ? `${tools[0].code} marcado como guardado` : `${fmt.tools(tools.length)} marcados como guardados`;
  return name ? `${text} por ${name}` : text;
}

/**
 * Re-checks-out tools after "Deshacer". Works even when the screen is gone, but only
 * for the operator who returned them (the device may have changed hands meanwhile).
 */
async function undoReturn(tools, operatorId) {
  if (store.get().operator?.id !== operatorId) {
    toast('No se puede deshacer: ha cambiado el operario.', { type: 'warning' });
    return;
  }
  const results = await Promise.allSettled(tools.map((tool) => api.checkout(tool.id)));
  const restored = [];
  results.forEach((result, i) => {
    const tool = tools[i];
    if (result.status === 'fulfilled') {
      restored.push(tool);
      cancelExpectedRemoval(tool.id);
      return;
    }
    const err = result.reason;
    if (err?.code === 'HELD_BY_OTHER' || err?.code === 'TOOL_INACTIVE') {
      toast(`No se puede deshacer ${tool.code}: ${err.message}`, { type: 'warning' });
    } else {
      toastError(err);
    }
  });
  const name = currentOperator()?.name;
  const owner = name ? `a nombre de ${name}` : 'a tu nombre';
  if (restored.length === 1) toast(`${restored[0].code} vuelve a estar ${owner}`);
  else if (restored.length > 1) toast(`${fmt.tools(restored.length)} vuelven a estar ${owner}`);
  await refreshMine();
}

export function mountPickup(root, { direction, restoreScroll }) {
  document.title = 'Guardar · Nevko';

  const hiding = new Set(); // ids returned (or being returned): left out of the list
  const busy = new Set(); // ids whose return request is running
  let animating = 0; // removals in progress: store updates wait until they finish
  let undoing = 0; // "Deshacer" in progress: marked rows wait before leaving
  let flushTimer = null; // marked rows leave when it fires
  let guardUntil = 0; // performance.now() until which "Guardado" taps are ignored
  let destroyed = false;
  let signature = null;
  let scrollRestored = direction !== 'back' && direction !== 'forward';

  const title = h('h1.page-title#pickup-title', { tabIndex: -1 }, 'Guardar');
  const subtitle = h('p.page-subtitle');
  const header = h('header.page-header', h('div.page-header-text', title, subtitle));
  const content = h('div.pickup-content');

  const allButton = button({
    label: 'Marcar todo como guardado',
    icon: 'check-check',
    variant: 'primary',
    size: 'lg',
    block: true,
    className: 'btn-wrap',
    onClick: () => void returnAll(),
  });
  // Outside .view: the view's entrance animation uses a transform, which would
  // make this fixed bar move with it.
  const actionbar = h('div.actionbar', { hidden: true }, h('div.actionbar-inner', allButton));

  const view = h('div.view', header, content);
  root.append(view, actionbar);

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.mine !== previous.mine || state.mineLoaded !== previous.mineLoaded || state.mineError !== previous.mineError) {
      render();
    }
  });

  render();
  void refreshMine();

  // Rendering --------------------------------------------------------------------

  function visibleTools() {
    return store.get().mine.filter((tool) => !hiding.has(tool.id));
  }

  /** Rows marked "Guardado" are waiting to leave, or leaving: the list must not move now. */
  function frozen() {
    return animating > 0 || content.querySelector('.stop-item.is-stored') !== null;
  }

  function setActionbar(count) {
    const show = count > 1; // a single tool has its own "Guardado"
    actionbar.hidden = !show;
    document.body.classList.toggle('has-actionbar', show);
    allButton.querySelector('.btn-label').textContent = `Marcar todo como guardado (${count})`;
  }

  /** Title count and sticky bar while marked rows are still shown. */
  function updateCounts() {
    const count = visibleTools().length;
    title.textContent = count ? `Guardar · ${fmt.tools(count)}` : 'Guardar';
    setActionbar(count);
  }

  function setSubtitle(count, stops) {
    const name = currentOperator()?.name;
    const hint =
      count === 1
        ? 'Guárdalo en su ubicación.'
        : stops > 1
          ? 'Guárdalos en su ubicación, zona por zona.'
          : 'Guárdalos en su ubicación.';
    subtitle.replaceChildren(...(name ? ['A nombre de ', h('strong', name), '. '] : []), hint);
  }

  function render({ force = false } = {}) {
    if (destroyed || (!force && frozen())) return;
    const state = store.get();

    if (!state.mineLoaded) {
      signature = null;
      setActionbar(0);
      title.textContent = 'Guardar';
      subtitle.hidden = true;
      content.replaceChildren(
        state.mineError
          ? errorState(state.mineError, () => {
              store.set({ mineError: null });
              void refreshMine();
            })
          : skeleton(3, 'card'),
      );
      return;
    }

    // Returned tools stop being hidden once the list no longer has them.
    const held = new Set(state.mine.map((tool) => tool.id));
    for (const id of hiding) if (!busy.has(id) && !held.has(id)) hiding.delete(id);

    const tools = visibleTools();
    const nextSignature = JSON.stringify(
      tools.map((t) => [t.id, t.code, t.location, t.description, t.holder?.since ?? null, t.unitIndex, t.unitCount, t.container]),
    );
    if (!force && nextSignature === signature) return;
    // The rows move: a tap aimed at one row must not land on the one taking its place.
    if (signature !== null && nextSignature !== signature) guardUntil = performance.now() + MOVE_GUARD_MS;
    signature = nextSignature;

    const count = tools.length;
    const groups = groupByZone(tools);
    title.textContent = count ? `Guardar · ${fmt.tools(count)}` : 'Guardar';
    subtitle.hidden = count === 0;
    setSubtitle(count, groups.length);
    setActionbar(count);

    if (!count) {
      content.replaceChildren(
        emptyState({
          icon: 'check-circle',
          tone: 'success',
          title: 'No tienes útiles pendientes de guardar',
          text: 'Cuando uses un útil aparecerá aquí, con la ubicación donde debes dejarlo.',
          action: button({ label: 'Buscar un útil', icon: 'search', href: '#/buscar' }),
        }),
      );
    } else {
      content.replaceChildren(h('ol.route', { 'aria-label': 'Útiles para guardar, por zona' }, groups.map(stop)));
    }

    if (!scrollRestored) {
      scrollRestored = true;
      restoreScroll?.();
    }
  }

  function stop(group, index) {
    return h(
      'li.stop',
      { dataset: { key: group.key } },
      zoneHead({ index, zone: group.label, empty: !group.key, count: group.tools.length }),
      h('ul.stop-items', group.entries.map(stopItem)),
    );
  }

  /** One tool of a zone card (`entry`: groupByZone() entries, with the slot for people). */
  function stopItem(entry) {
    const { tool } = entry;
    const since = tool.holder?.since;
    const item = h('li.stop-item', { dataset: { toolId: tool.id } });
    const saveButton = button({
      label: 'Guardado',
      icon: 'check',
      variant: 'secondary',
      className: 'stop-save',
      attrs: { 'aria-label': `Guardado: ${tool.code}` },
      onClick: () => void markStored(tool, item),
    });
    // Shown instead of the button once marked: same place and size, and not a button.
    const done = h('span.stop-done', { tabIndex: -1 }, icon('check', { size: 20 }), h('span', 'Guardado'));
    item.append(
      h(
        'div.stop-item-main',
        slotLines(tool.location, entry.slotLabel, containerHint(tool)),
        h('div.stop-code-row', h('a.stop-item-code', { href: router.href(`/util/${tool.id}`) }, tool.code), unitTag(tool)),
        tool.description ? h('div.stop-item-desc', tool.description) : null,
        since
          ? h(
              'div.stop-item-meta',
              icon('clock', { size: 14 }),
              h('span', 'en uso desde ', fmt.clock(since), ' (', liveTime(since, fmt.elapsed), ')'),
            )
          : null,
      ),
      h('div.stop-item-action', saveButton, done),
    );
    return item;
  }

  /** After items disappear, keep keyboard focus near where it was. */
  function refocus(index) {
    const buttons = content.querySelectorAll('.stop-save');
    const target = buttons[Math.min(index, buttons.length - 1)];
    (target ?? title).focus({ preventScroll: true });
  }

  function scheduleFlush(delay = STORED_HOLD_MS) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(), delay);
  }

  /**
   * The rows marked "Guardado" leave together (the whole location card when all its rows
   * are marked) and the list is rendered again.
   */
  async function flush() {
    flushTimer = null;
    if (destroyed || busy.size || undoing) return; // the last request or undo schedules it again
    if (animating) {
      scheduleFlush(MOVE_GUARD_MS);
      return;
    }
    const items = Array.from(content.querySelectorAll('.stop-item'));
    const stored = items.filter((item) => item.classList.contains('is-stored'));
    if (!stored.length) {
      render({ force: true });
      return;
    }
    const hadFocus = content.contains(document.activeElement);
    const position = items.indexOf(stored[0]);
    const targets = new Set(
      stored.map((item) => {
        const stopEl = item.closest('.stop');
        const all = Array.from(stopEl?.querySelectorAll('.stop-item') ?? []);
        return all.length && all.every((el) => el.classList.contains('is-stored')) ? stopEl : item;
      }),
    );
    animating += 1;
    await Promise.all([...targets].map((el) => collapseOut(el)));
    animating -= 1;
    render({ force: true });
    if (hadFocus) refocus(position);
  }

  /** After a failed return or an undo: marked rows still leave together; otherwise re-render. */
  function settle() {
    if (destroyed || animating) return;
    if (content.querySelector('.stop-item.is-stored')) {
      if (!flushTimer) scheduleFlush();
    } else {
      render({ force: true });
    }
  }

  // Actions ----------------------------------------------------------------------

  async function markStored(tool, item) {
    if (destroyed || hiding.has(tool.id) || animating || performance.now() < guardUntil) return;
    const operator = currentOperator(); // who returns it: only they can undo it
    const hadFocus = item.contains(document.activeElement);

    hiding.add(tool.id);
    busy.add(tool.id);
    expectRemoval(tool.id);
    clearTimeout(flushTimer); // the marked rows leave once the operator stops marking
    flushTimer = null;
    item.classList.add('is-stored');
    if (hadFocus) item.querySelector('.stop-done').focus({ preventScroll: true });
    updateCounts();

    const err = await api.returnTool(tool.id).then(
      () => null,
      (error) => error,
    );
    busy.delete(tool.id);

    if (!err) {
      toast(storedText([tool], operator?.name), {
        type: 'success',
        action: { label: 'Deshacer', onClick: () => void undo([tool], operator?.id ?? null) },
      });
      void refreshMine();
      if (!destroyed) scheduleFlush();
      return;
    }

    hiding.delete(tool.id);
    if (err.code === 'HELD_BY_OTHER') {
      // Someone else has it now: the list drops it and there is nothing to store.
      toast(err.message, { type: 'warning' });
    } else {
      cancelExpectedRemoval(tool.id);
      toastError(err);
    }
    if (!destroyed) {
      const doneHadFocus = item.contains(document.activeElement);
      item.classList.remove('is-stored');
      if (doneHadFocus) item.querySelector('.stop-save').focus({ preventScroll: true });
      updateCounts();
    }
    await refreshMine();
    settle();
  }

  /** "Deshacer": the tools go back to the operator and their rows return to normal. */
  async function undo(tools, operatorId) {
    if (!destroyed) {
      undoing += 1;
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await undoReturn(tools, operatorId);
    if (destroyed) return;
    undoing -= 1;
    const held = new Set(store.get().mine.map((tool) => tool.id));
    const restored = tools.filter((tool) => held.has(tool.id));
    for (const tool of restored) {
      hiding.delete(tool.id);
      content.querySelector(`.stop-item[data-tool-id="${tool.id}"]`)?.classList.remove('is-stored');
    }
    updateCounts();
    settle();
    if (restored.length) {
      const target = content.querySelector(`.stop-item[data-tool-id="${restored[0].id}"] .stop-save`);
      (target ?? title).focus({ preventScroll: true });
    }
  }

  async function returnAll() {
    const tools = visibleTools();
    const n = tools.length;
    if (!n || destroyed) return;
    const ids = tools.map((tool) => tool.id);
    const operator = currentOperator();
    let result = null;

    const ok = await confirm({
      title: '¿Marcar todo como guardado?',
      icon: 'check-check',
      message:
        n === 1
          ? `Confirma que has dejado ${tools[0].code} en su ubicación.`
          : `Confirma que has dejado los ${n} útiles en su ubicación.`,
      confirmLabel: `Marcar todo (${n})`,
      onConfirm: async () => {
        expectRemoval(ids);
        try {
          result = await api.returnMine(ids);
        } catch (err) {
          cancelExpectedRemoval(ids);
          toastError(err);
          return false; // keep the dialog open
        }
        return true;
      },
    });
    if (!ok || !result) return;

    const returned = Array.isArray(result.returned) ? result.returned : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    // Skipped tools keep their "expected removal" mark: the warning below already
    // explains why they are no longer listed, so no second notice is shown for them.

    if (!destroyed) {
      const returnedIds = new Set(returned.map((tool) => tool.id));
      for (const id of returnedIds) hiding.add(id);
      for (const el of content.querySelectorAll('.stop-item')) {
        if (returnedIds.has(Number(el.dataset.toolId))) el.classList.add('is-stored');
      }
      clearTimeout(flushTimer);
      await flush();
      title.focus({ preventScroll: true });
    }

    if (returned.length) {
      toast(storedText(returned, operator?.name), {
        type: 'success',
        action: { label: 'Deshacer', onClick: () => void undo(returned, operator?.id ?? null) },
      });
      announce(`${fmt.tools(returned.length)} marcados como guardados`);
    }
    if (skipped.length) {
      toast(
        skipped.length === 1
          ? '1 útil no se ha podido marcar: ya no estaba a tu nombre.'
          : `${fmt.tools(skipped.length)} no se han podido marcar: ya no estaban a tu nombre.`,
        { type: 'warning' },
      );
    }

    await refreshMine();
    render();
  }

  // Lifecycle --------------------------------------------------------------------

  return {
    /** Guardar tab tapped while already here: back to the top. */
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
