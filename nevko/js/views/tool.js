// #/util/:id — tool detail (SPEC §7): the assigned location in very large type (as written;
// for a tool inside a kit, "INCLUIDO EN VAT 8015", a line under it says where the kit is),
// the code with "Unidad 2 de 3" when the code has several units (and a link to all of them),
// the status block with its actions (use / hand-over / return, and "Añadir a la lista" /
// "Quitar de la lista" for the pick list), and the latest movements.

import { api } from '../api.js';
import { h, frag } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, button, emptyState, errorState, tag, toolStatus, unitTag } from '../components.js';
import * as fmt from '../fmt.js';
import { afterTaking, nowHeldText, reportNotRelisted, takeTool, togglePick } from '../picking.js';
import { router } from '../router.js';
import { addPicks, cancelExpectedRemoval, currentOperator, expectRemoval, isPickPending, refreshMine } from '../session.js';
import { resetSearch, setSearch, store } from '../store.js';
import { confirm, liveTime, toast, toastError, withBusy } from '../ui.js';

const LIVE_REFRESH_TYPES = new Set(['resync', 'import', 'tools', 'operators']);
// After "Ya lo he guardado", "Usar este útil" takes its place: it stays disabled this long,
// so a second (impatient or gloved) tap does not check the tool out again.
const USE_LOCK_MS = 1500;

/**
 * Leaves the detail after taking the tool: back to En lista when it was opened from there,
 * otherwise to an empty, focused search (chained quick flow).
 */
function leaveAfterTaking() {
  if (router.previousPath() === '/lista') {
    router.back('/lista');
    return;
  }
  resetSearch();
  if (router.previousPath() === '/buscar') router.back();
  else router.navigate('/buscar', { replace: true });
}

const BACK_LABELS = { '/guardar': 'Guardar', '/lista': 'En lista' };

export function mountTool(root, { route }) {
  const id = Number(route.params.id);
  let tool = null;
  let destroyed = false;
  let failed = false; // the last load failed (not a 404): retried on the next server event
  let focusPending = false; // focusTitle() came before the tool was shown
  let returnedAt = 0; // when this screen returned the tool ("Ya lo he guardado")
  let reloadTimer = null;
  let unlockTimer = null;
  let loadSeq = 0;

  const view = h('div.view');
  root.append(view);
  document.title = 'Útil · Nevko';

  // The back arrow names the screen it returns to (the detail opens from Buscar, En lista or Guardar).
  const backLabel = BACK_LABELS[router.previousPath()] ?? 'Buscar';

  // The pick list button follows the list (also when it changes on another device).
  const unsubscribePicks = store.select(
    (state) => state.pickIds.has(id),
    () => {
      if (tool && !destroyed) render();
    },
    { immediate: false },
  );
  const backButton = () =>
    h(
      'div.subheader',
      button({ icon: 'arrow-left', label: backLabel, variant: 'ghost', onClick: () => router.back('/buscar') }),
    );

  if (!Number.isSafeInteger(id) || id <= 0) renderNotFound();
  else {
    renderLoading();
    void load();
  }

  async function load({ silent = false } = {}) {
    const mySeq = ++loadSeq;
    try {
      const data = await api.tool(id);
      if (destroyed || mySeq !== loadSeq) return;
      tool = data.tool;
      render();
    } catch (err) {
      if (destroyed || mySeq !== loadSeq || err.code === 'ABORTED') return;
      if (err.status === 404) renderNotFound();
      else if (!silent || !tool) renderError(err);
    }
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void load({ silent: true }), 150);
  }

  // Rendering --------------------------------------------------------------------

  function renderLoading() {
    view.replaceChildren(
      backButton(),
      h(
        'div.loc-hero',
        { 'aria-busy': 'true' },
        h('div.skeleton.skeleton-line', { style: { width: '40%' } }),
        h('div.skeleton', { style: { width: '70%', height: '40px', marginTop: '12px' } }),
        h('div.skeleton.skeleton-line', { style: { width: '85%', marginTop: '24px' } }),
      ),
      h('div.skeleton-card.mt-3', h('div.skeleton.skeleton-title', { style: { width: '50%' } }), h('div.skeleton', { style: { height: '56px' } })),
    );
  }

  function renderNotFound() {
    failed = false;
    document.title = 'Útil no encontrado · Nevko';
    view.replaceChildren(
      backButton(),
      emptyState({
        icon: 'search-x',
        title: 'Este útil no existe',
        text: 'Puede que se haya eliminado del catálogo. Vuelve a buscarlo por su código.',
        action: button({ label: 'Buscar un útil', icon: 'search', variant: 'primary', onClick: () => router.navigate('/buscar', { replace: true }) }),
      }),
    );
  }

  function renderError(err) {
    failed = true;
    view.replaceChildren(backButton(), errorState(err, () => (renderLoading(), void load()), { title: 'No se ha podido cargar el útil' }));
  }

  function render() {
    failed = false;
    document.title = `${tool.code} · Nevko`;
    const hadFocus = view.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    view.replaceChildren(backButton(), hero(), statusBlock(), historySection());
    if (hadFocus) view.querySelector(`[data-focus-key="${hadFocus}"]`)?.focus();
    if (focusPending) {
      // The screen opened while loading: move focus to the code now, unless it went elsewhere.
      focusPending = false;
      const active = document.activeElement;
      if (!active || active === document.body || active.id === 'main') view.querySelector('#tool-code')?.focus({ preventScroll: true });
    }
  }

  function hero() {
    const location = tool.location;
    const units = Number(tool.unitCount) || 0;
    return h(
      'section.loc-hero',
      { 'aria-labelledby': 'tool-code' },
      h('div.loc-label', icon('map-pin', { size: 16 }), 'Ubicación asignada'),
      h(
        'div.loc-value',
        { class: { 'is-empty': !location }, dataset: { length: location ? fmt.locationLength(location) : null } },
        location ? fmt.keepHyphens(location) : 'Sin ubicación asignada',
      ),
      kitLine(),
      h(
        'div.loc-desc',
        h(
          'div.tool-code-row',
          h('h1.tool-code#tool-code', { tabIndex: -1, style: { fontSize: '20px', color: 'var(--text)' } }, tool.code),
          unitTag(tool),
        ),
        tool.description ? h('p.mt-1', tool.description) : h('p.mt-1.subtle', 'Sin descripción'),
        units > 1
          ? h(
              'a.unit-link',
              { href: router.href('/buscar'), onClick: (event) => showAllUnits(event) },
              icon('list', { size: 16 }),
              `Ver las ${units} unidades`,
            )
          : null,
      ),
    );
  }

  /** Under the location of a tool inside a kit: "El juego VAT 8015 está en AR1" (+ link to the kit). */
  function kitLine() {
    const sentence = fmt.containerSentence(tool.container);
    if (!sentence) return null;
    const kitId = Number(tool.container.toolId);
    return h(
      'p.loc-kit',
      icon('package', { size: 16 }),
      h('span', fmt.keepHyphens(sentence), '.'),
      Number.isSafeInteger(kitId) && kitId > 0 && kitId !== id
        ? h('a.loc-kit-link', { href: router.href(`/util/${kitId}`) }, `Ver ${tool.container.code}`)
        : null,
    );
  }

  /** "Ver las N unidades": Buscar with this code (every unit is its own result). */
  function showAllUnits(event) {
    event.preventDefault();
    setSearch({ query: tool.code, result: null, focus: false });
    router.navigate('/buscar');
  }

  function sinceText(since) {
    return frag('desde ', fmt.dateTime(since), ' (', liveTime(since, fmt.elapsed), ')');
  }

  /** "Añadir a la lista" (free tools) / "Quitar de la lista" (any listed tool). */
  function listButton(status) {
    const listed = store.get().pickIds.has(id);
    if (!listed && status !== 'available') return null;
    return button({
      label: listed ? 'Quitar de la lista' : 'Añadir a la lista',
      icon: listed ? 'x' : 'list-plus',
      variant: 'secondary',
      size: 'lg',
      block: true,
      attrs: { 'data-focus-key': 'list' },
      onClick: () => void toggleList(),
    });
  }

  function statusBlock() {
    const status = toolStatus(tool);
    const inactiveNote = tool.active === false ? tag('Dado de baja', 'warning') : null;
    if (status !== 'available') returnedAt = 0;

    if (status === 'mine') {
      const returnButton = button({
        label: 'Ya lo he guardado',
        icon: 'check',
        variant: 'primary',
        size: 'lg',
        block: true,
        attrs: { 'data-focus-key': 'return' },
        onClick: () => giveBack(returnButton),
      });
      return statusCard('mine', 'user', h('span', 'Lo tienes tú'), [sinceText(tool.holder.since), inactiveNote ? [' ', inactiveNote] : null], [returnButton]);
    }

    if (status === 'other') {
      const actions = [];
      if (tool.active !== false) {
        const transferButton = button({
          label: 'Me lo ha pasado',
          icon: 'transfer',
          variant: 'secondary',
          size: 'lg',
          block: true,
          className: 'btn-wrap',
          attrs: { 'data-focus-key': 'transfer' },
          onClick: () => transfer(transferButton),
        });
        actions.push(transferButton);
      }
      const unlist = listButton(status);
      if (unlist) actions.push(unlist);
      return statusCard(
        'other',
        'user',
        h('span', 'Lo tiene ', h('strong', tool.holder.name)),
        [sinceText(tool.holder.since), inactiveNote ? [' ', inactiveNote] : null],
        actions,
      );
    }

    if (status === 'inactive') {
      return statusCard(
        'inactive',
        'alert-circle',
        h('span', 'Dado de baja'),
        'Este útil ya no forma parte del catálogo activo. Consulta con el responsable del taller.',
        [listButton(status)].filter(Boolean),
      );
    }

    const lockLeft = returnedAt ? USE_LOCK_MS - (Date.now() - returnedAt) : 0;
    const useButton = button({
      label: 'Usar este útil',
      icon: 'check',
      variant: 'primary',
      size: 'lg',
      block: true,
      disabled: lockLeft > 0,
      attrs: { 'data-focus-key': 'use' },
      onClick: () => use(useButton),
    });
    clearTimeout(unlockTimer);
    if (lockLeft > 0) {
      unlockTimer = setTimeout(() => {
        useButton.disabled = false;
      }, lockLeft);
    }
    return statusCard(
      'available',
      'check-circle',
      h('span', 'Disponible'),
      returnedAt ? 'Lo acabas de guardar en su ubicación.' : 'Nadie lo está usando ahora mismo.',
      [useButton, listButton(status)].filter(Boolean),
    );
  }

  function statusCard(kind, iconName, title, metaContent, actions) {
    const name = currentOperator()?.name;
    return h(
      'section.status.mt-3',
      { class: `status-${kind}`, 'aria-label': 'Estado' },
      h(
        'div.status-head',
        h('div.status-icon', icon(iconName, { size: 22 })),
        h('div.status-text', h('div.status-title', title), metaContent ? h('div.status-meta', metaContent) : null),
      ),
      actions.length ? h('div.status-actions', actions) : null,
      // Whose name the action is recorded under (a device may be shared by several operators).
      actions.length && name ? h('p.status-owner', 'Se registrará a nombre de ', h('strong', name)) : null,
    );
  }

  function historySection() {
    const items = Array.isArray(tool.history) ? tool.history : [];
    return h(
      'section.section',
      { 'aria-labelledby': 'history-title' },
      h('h2.section-title#history-title', 'Últimos movimientos'),
      items.length
        ? h('div.card', h('ul.timeline', items.map(historyItem)))
        : h('div.card', emptyState({ icon: 'history', title: 'Sin movimientos', text: 'Nadie ha usado todavía este útil.', compact: true })),
    );
  }

  function historyItem(entry) {
    const open = !entry.returnedAt;
    const when = open
      ? frag('desde ', fmt.dateTime(entry.takenAt), ' · ', liveTime(entry.takenAt, fmt.elapsed))
      : frag(
          fmt.dateTime(entry.takenAt),
          ' – ',
          fmt.dateTime(entry.returnedAt),
          ' · ',
          fmt.duration(new Date(entry.returnedAt) - new Date(entry.takenAt)),
        );
    return h(
      'li.timeline-item',
      avatar(entry.operatorName, { size: 'sm' }),
      h('span.timeline-name', entry.operatorName),
      h('span.timeline-type', open ? tag('En uso', 'primary') : tag(fmt.returnTypeLabel(entry.returnType), entry.returnType === 'forced' ? 'warning' : null)),
      h('span.timeline-when', when),
    );
  }

  // Actions ----------------------------------------------------------------------

  function handleActionError(err) {
    if (err.status === 404) {
      renderNotFound();
      return;
    }
    if (err.code === 'HELD_BY_OTHER' || err.code === 'TOOL_INACTIVE') {
      toast(err.message, { type: 'warning' });
      void load({ silent: true });
      return;
    }
    toastError(err);
  }

  function use(btn) {
    return withBusy(btn, async () => {
      try {
        // "Deshacer" (in the toast) puts it back as free, and in the pick list if it was there.
        await takeTool(tool, { onUndone: () => !destroyed && void load({ silent: true }) });
        if (!destroyed) leaveAfterTaking();
      } catch (err) {
        handleActionError(err);
      }
    });
  }

  /** "Añadir a la lista" / "Quitar de la lista" (the button changes at once). */
  async function toggleList() {
    if (!tool || isPickPending(id)) return;
    const current = tool;
    const operatorId = currentOperator()?.id ?? null;
    const listed = await togglePick(current);
    if (listed === true) {
      toast(`${current.code} añadido a tu lista`, {
        type: 'success',
        action: { label: 'Ver lista', onClick: () => router.navigate('/lista') },
      });
    } else if (listed === false) {
      toast(`${current.code} quitado de tu lista`, {
        action: {
          label: 'Deshacer',
          onClick: () => {
            if (store.get().operator?.id !== operatorId) {
              toast('No se puede deshacer: ha cambiado el operario.', { type: 'warning' });
              return;
            }
            addPicks([current.id]).then(
              (result) => reportNotRelisted(result?.skipped),
              (err) => toastError(err),
            );
          },
        },
      });
    } else if (!destroyed) {
      void load({ silent: true }); // refused: e.g. someone took it or it was deactivated meanwhile
    }
  }

  async function transfer(btn) {
    const holder = tool.holder;
    const holderName = holder?.name ?? 'otro operario';
    const code = tool.code;
    const ok = await confirm({
      title: '¿Pasar a tu nombre?',
      icon: 'transfer',
      message: h(
        'p',
        'El útil ',
        h('strong.tool-code', code),
        ' figura en uso por ',
        h('strong', holderName),
        '. Confírmalo solo si te lo ha entregado.',
      ),
      confirmLabel: 'Pasar a mi nombre',
    });
    if (!ok || destroyed) return;
    await withBusy(btn, async () => {
      try {
        // The holder confirmed in the dialog: if it has changed hands meanwhile, the server refuses.
        const { tool: updated } = await api.checkout(id, { transfer: true, fromOperatorId: holder?.operatorId ?? null });
        afterTaking([id]); // also leaves the pick list
        toast(nowHeldText([updated]), { type: 'success' });
        if (!destroyed) leaveAfterTaking();
      } catch (err) {
        if (err.code === 'HOLDER_CHANGED' && err.data?.holder) {
          if (destroyed) return;
          tool = { ...tool, holder: err.data.holder };
          render();
          toast(`Ahora lo tiene ${err.data.holder.name}; confirma de nuevo si te lo ha pasado.`, { type: 'warning' });
          void load({ silent: true }); // history and anything else that changed
          return;
        }
        handleActionError(err);
      }
    });
  }

  function giveBack(btn) {
    const code = tool.code;
    const operatorId = store.get().operator?.id ?? null;
    const name = currentOperator()?.name;
    return withBusy(btn, async () => {
      expectRemoval(id);
      try {
        await api.returnTool(id);
        returnedAt = Date.now();
        void refreshMine();
        toast(name ? `${code} marcado como guardado por ${name}` : `${code} marcado como guardado`, {
          type: 'success',
          action: { label: 'Deshacer', onClick: () => void undoReturn(code, operatorId) },
        });
        await load({ silent: true });
      } catch (err) {
        cancelExpectedRemoval(id);
        handleActionError(err);
      }
    });
  }

  async function undoReturn(code, operatorId) {
    if (store.get().operator?.id !== operatorId) {
      toast('No se puede deshacer: ha cambiado el operario.', { type: 'warning' });
      return;
    }
    try {
      await api.checkout(id);
      cancelExpectedRemoval(id);
      toast(nowHeldText([{ code }]));
    } catch (err) {
      if (err.code === 'HELD_BY_OTHER') toast(`No se puede deshacer: ${err.message}`, { type: 'warning' });
      else toastError(err);
    } finally {
      void refreshMine();
      if (!destroyed) void load({ silent: true });
    }
  }

  return {
    onChange(event) {
      if (!tool) {
        // The load failed (e.g. no connection): any server event means it can be retried now.
        if (failed) scheduleReload();
        return;
      }
      if (LIVE_REFRESH_TYPES.has(event.type) || !event.toolIds.length || event.toolIds.includes(id)) scheduleReload();
    },
    focusTitle() {
      const title = view.querySelector('#tool-code');
      if (title) title.focus({ preventScroll: true });
      else focusPending = true;
    },
    destroy() {
      destroyed = true;
      clearTimeout(reloadTimer);
      clearTimeout(unlockTimer);
      unsubscribePicks();
    },
  };
}
