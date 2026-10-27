// #/admin/operarios — operator list (PIN yes/no, tools in use, state), "Nuevo operario"
// dialog (name + optional 4-6 digit PIN) and the edit panel (name; PIN keep / change /
// remove; the tools the operator holds, each one returnable, plus "Devolver todos";
// active switch with a confirmation that offers to return the tools still held).
// 409 NAME_EXISTS is shown on the name field.

import { alertBox, avatar, button, containerHint, emptyState, field, input, pill, segmented, tag, unitTag } from '../components.js';
import { h, highlight, replace } from '../dom.js';
import * as fmt from '../fmt.js';
import { icon } from '../icons.js';
import { cleanText, textNorm } from '../normalize.js';
import * as ui from '../ui.js';
import {
  adminRequest,
  clickableRow,
  dataTable,
  debounce,
  forceReturn,
  inlineError,
  liveDuration,
  pageHeader,
  pinInput,
  primaryAction,
  reportError,
  submitOnEnter,
  switchControl,
  tableSkeleton,
} from './common.js';

const NAME_MAX = 60;
const PIN_RE = /^\d{4,6}$/;
const FILTER_THRESHOLD = 8;
const REFRESH_DELAY_MS = 300;
const NAME_ERRORS = new Set(['NAME_EXISTS', 'NAME_REQUIRED', 'VALIDATION']);

export function mountOperators(root, env) {
  const state = env.store;
  state.filter ??= '';
  const intent = state.intent;
  state.intent = null;

  let operators = null;
  let error = null;
  let controller = null;
  let destroyed = false;

  const header = pageHeader({
    title: 'Operarios',
    subtitle: 'Personas que usan la app en el taller.',
    actions: button({ label: 'Nuevo operario', icon: 'user-plus', variant: 'primary', onClick: () => openCreator() }),
  });
  const filterInput = h('input.input', {
    type: 'search',
    value: state.filter,
    placeholder: 'Buscar por nombre',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Buscar operarios por nombre',
    onInput: () => {
      state.filter = filterInput.value;
      renderList();
    },
  });
  const toolbar = h('div.toolbar.adm-toolbar', { hidden: true }, h('div.toolbar-grow.input-group', icon('search'), filterInput));
  const results = h('div.adm-results');
  root.append(header.el, toolbar, results);

  const refreshSoon = debounce(() => void load({ silent: true }), REFRESH_DELAY_MS);

  renderList();
  void load();
  if (intent?.create) requestAnimationFrame(() => !destroyed && openCreator());

  // Data ------------------------------------------------------------------------

  async function load({ silent = false } = {}) {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const result = await adminRequest('GET', '/admin/operators', { signal: mine.signal });
      if (destroyed || controller !== mine) return;
      operators = Array.isArray(result?.operators) ? result.operators : [];
      error = null;
    } catch (err) {
      if (destroyed || controller !== mine || err.code === 'ABORTED' || err.status === 401) return;
      if (silent && operators) return;
      error = err;
    }
    renderList();
  }

  // Rendering ---------------------------------------------------------------------

  function renderList() {
    if (destroyed) return;
    if (!operators) {
      replace(results, h('div.card', error ? inlineError(error, retry) : tableSkeleton(5, 4)));
      return;
    }
    const active = operators.filter((op) => op.active).length;
    const inactive = operators.length - active;
    header.setSubtitle(
      operators.length
        ? [fmt.count(active, 'operario activo', 'operarios activos'), inactive ? fmt.count(inactive, 'desactivado', 'desactivados') : null]
            .filter(Boolean)
            .join(' · ')
        : 'Personas que usan la app en el taller.',
    );
    toolbar.hidden = operators.length <= FILTER_THRESHOLD;

    if (operators.length === 0) {
      replace(
        results,
        h(
          'div.card',
          emptyState({
            icon: 'users',
            title: 'Todavía no hay operarios',
            text: 'Da de alta a cada persona del taller. Al entrar en la app elegirán su nombre; el PIN es opcional.',
            action: button({ label: 'Nuevo operario', icon: 'user-plus', variant: 'primary', onClick: () => openCreator() }),
          }),
        ),
      );
      return;
    }

    const needle = toolbar.hidden ? '' : textNorm(state.filter);
    const visible = needle ? operators.filter((op) => textNorm(op.name).includes(needle)) : operators;
    if (visible.length === 0) {
      replace(
        results,
        h('div.card', emptyState({ icon: 'search-x', title: `Ningún operario coincide con «${state.filter.trim()}»`, compact: true })),
      );
      return;
    }
    replace(results, h('div.table-wrap', operatorTable(visible, toolbar.hidden ? '' : state.filter)));
  }

  function retry() {
    error = null;
    renderList();
    void load();
  }

  function operatorTable(list, query) {
    return dataTable({
      caption: 'Operarios',
      rows: list,
      rowProps: (op) => ({ ...clickableRow(() => openEditor(op)), class: ['is-clickable', !op.active && 'is-muted'] }),
      columns: [
        {
          label: 'Operario',
          primary: true,
          cell: (op) =>
            h(
              'span.adm-person',
              avatar(op.name),
              h(
                'span.adm-person-text',
                h(
                  'button.adm-link.adm-person-name',
                  { type: 'button', 'aria-label': `Editar a ${op.name}`, onClick: () => openEditor(op) },
                  highlight(op.name, query, { mode: 'text' }),
                ),
              ),
            ),
        },
        {
          label: 'PIN',
          cell: (op) =>
            op.hasPin
              ? h('span.adm-inline', icon('lock', { size: 16 }), 'Con PIN')
              : h('span.adm-inline.subtle', icon('unlock', { size: 16 }), 'Sin PIN'),
        },
        {
          label: 'En uso',
          cell: (op) => (op.inUseCount ? tag(fmt.tools(op.inUseCount), 'warning') : h('span.subtle', 'Ninguno')),
        },
        {
          label: 'Estado',
          cell: (op) => (op.active ? pill('available', 'Activo') : pill('inactive', 'Desactivado')),
        },
        {
          label: '',
          srLabel: 'Acciones',
          className: 'cell-actions adm-col-edit',
          cell: (op) =>
            button({ label: 'Editar', icon: 'edit', variant: 'ghost', size: 'sm', ariaLabel: `Editar a ${op.name}`, onClick: () => openEditor(op) }),
        },
      ],
    });
  }

  // Shared form pieces ---------------------------------------------------------------

  function nameInput(value = '') {
    return input({
      value,
      attrs: { maxlength: String(NAME_MAX), autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', required: true },
    });
  }

  /** Shows a server error on the matching field. Returns true when handled. */
  function showFieldError(err, { nameField, nameEl, pinField, pinEl }) {
    if (NAME_ERRORS.has(err.code) && !/PIN/i.test(err.message)) {
      nameField.setError(err.message);
      nameEl.focus();
      return true;
    }
    if (err.code === 'PIN_FORMAT' && pinField) {
      pinField.setError(err.message);
      pinEl.focus();
      return true;
    }
    return false;
  }

  // "Nuevo operario" -------------------------------------------------------------------

  function openCreator() {
    const nameEl = nameInput();
    const nameField = field({ label: 'Nombre', control: nameEl, hint: 'Tal como aparecerá en la pantalla «¿Quién eres?».' });
    const pinEl = pinInput({ maxLength: 6, placeholder: '4 a 6 dígitos' });
    const pinField = field({
      label: 'PIN',
      control: pinEl,
      optional: true,
      hint: 'Déjalo vacío para entrar sin PIN. Si lo pones, comunícaselo al operario.',
    });
    const notice = h('div', { hidden: true });
    let allowDuplicateOfInactive = false;
    const form = h('form.form', { noValidate: true, autocomplete: 'off' }, nameField, pinField, notice);

    const layer = ui.dialog({
      title: 'Nuevo operario',
      icon: 'user-plus',
      content: form,
      className: 'adm-layer',
      actions: [
        { label: 'Cancelar', variant: 'secondary', value: false },
        { label: 'Crear operario', variant: 'primary', icon: 'check', onClick: () => create() },
      ],
    });
    submitOnEnter(form, () => primaryAction(layer));
    nameEl.addEventListener('input', () => {
      allowDuplicateOfInactive = false;
      notice.hidden = true;
    });

    async function create() {
      nameField.setError(null);
      pinField.setError(null);
      const name = cleanText(nameEl.value);
      const pin = pinEl.value;
      if (!name) {
        nameField.setError('Indica el nombre del operario.');
        nameEl.focus();
        return false;
      }
      if (pin && !PIN_RE.test(pin)) {
        pinField.setError('El PIN debe tener entre 4 y 6 dígitos.');
        pinEl.focus();
        return false;
      }
      const inactiveTwin = operators?.find((op) => !op.active && textNorm(op.name) === textNorm(name));
      if (inactiveTwin && !allowDuplicateOfInactive) {
        showInactiveTwin(inactiveTwin);
        return false;
      }
      try {
        const result = await adminRequest('POST', '/admin/operators', { body: pin ? { name, pin } : { name } });
        ui.toast(`${result?.operator?.name ?? name} añadido.`, { type: 'success' });
        refreshSoon();
        return true;
      } catch (err) {
        if (err.status === 401) return true;
        if (showFieldError(err, { nameField, nameEl, pinField, pinEl })) return false;
        reportError(err, 'No se ha podido crear el operario.');
        return false;
      }
    }

    function showInactiveTwin(twin) {
      notice.hidden = false;
      replace(
        notice,
        alertBox({
          type: 'warning',
          title: `Ya existe «${twin.name}», desactivado`,
          text: 'Si es la misma persona, reactívalo para conservar su historial.',
          action: h(
            'div.btn-group',
            button({
              label: 'Reactivar',
              icon: 'undo',
              size: 'sm',
              variant: 'primary',
              onClick: async (event) => {
                const ok = await ui.withBusy(event.currentTarget, () => setActive(twin, true));
                if (ok) void layer.close(true);
              },
            }),
            button({
              label: 'Crear uno nuevo',
              size: 'sm',
              onClick: () => {
                allowDuplicateOfInactive = true;
                notice.hidden = true;
                primaryAction(layer)?.click();
              },
            }),
          ),
        }),
      );
    }
  }

  async function setActive(op, active) {
    try {
      await adminRequest('PATCH', `/admin/operators/${encodeURIComponent(op.id)}`, { body: { active } });
      ui.toast(active ? `${op.name} reactivado.` : `${op.name} desactivado.`, { type: 'success' });
      refreshSoon();
      return true;
    } catch (err) {
      reportError(err, 'No se ha podido cambiar el estado del operario.');
      return false;
    }
  }

  // Edit panel -----------------------------------------------------------------------------

  function openEditor(op) {
    const nameEl = nameInput(op.name);
    const nameField = field({ label: 'Nombre', control: nameEl, hint: 'Tal como aparecerá en la pantalla «¿Quién eres?».' });

    const pinEl = pinInput({ maxLength: 6, placeholder: '4 a 6 dígitos' });
    const pinField = field({ label: op.hasPin ? 'Nuevo PIN' : 'PIN', control: pinEl, hint: 'Solo números, de 4 a 6 dígitos.' });
    const pinMode = segmented({
      label: 'PIN del operario',
      block: true,
      value: 'keep',
      options: op.hasPin
        ? [
            { value: 'keep', label: 'Mantener' },
            { value: 'change', label: 'Cambiar' },
            { value: 'remove', label: 'Quitar' },
          ]
        : [
            { value: 'keep', label: 'Sin PIN' },
            { value: 'change', label: 'Añadir PIN' },
          ],
      onChange: () => renderPin(),
    });
    const pinNote = h('p.field-hint.adm-note', icon('info', { size: 14 }), 'El operario tendrá que volver a identificarse en sus dispositivos.');

    const activeSwitch = switchControl({
      checked: op.active,
      label: 'Operario activo',
      hint: 'Los operarios desactivados no aparecen al entrar en la app y se cierran sus sesiones. Su historial se conserva.',
      onChange: () => renderWarning(),
    });
    const warning = h('div', { hidden: true });

    let inUse = op.inUseCount ?? 0; // kept up to date by the "Útiles en uso" list
    const summaryMeta = h('div.small.muted');
    const renderSummaryMeta = () => {
      summaryMeta.textContent = [op.hasPin ? 'Con PIN' : 'Sin PIN', inUse ? `${fmt.tools(inUse)} en uso` : 'Sin útiles en uso', op.active ? null : 'Desactivado']
        .filter(Boolean)
        .join(' · ');
    };
    renderSummaryMeta();
    const summary = h(
      'div.adm-op-summary',
      avatar(op.name, { size: 'lg' }),
      h('div.grow', h('div.adm-op-name', op.name), summaryMeta),
      button({
        label: 'Historial',
        icon: 'history',
        variant: 'ghost',
        size: 'sm',
        ariaLabel: `Ver el historial de ${op.name}`,
        onClick: () => env.go('historial', { operatorId: op.id }),
      }),
    );

    const heldBox = h('section.adm-held', { hidden: inUse === 0, 'aria-label': 'Útiles en uso' });
    let held = null; // tools this operator holds (loaded when the panel opens)
    let heldController = null;

    const form = h(
      'form.form',
      { noValidate: true, autocomplete: 'off' },
      summary,
      heldBox,
      nameField,
      h(
        'fieldset.adm-fieldset',
        h('legend.field-label', 'PIN'),
        pinMode,
        pinField,
        pinNote,
      ),
      h('div.adm-switch-row', activeSwitch.el),
      warning,
    );

    const layer = ui.panel({
      title: 'Editar operario',
      description: op.name,
      content: form,
      className: 'adm-layer',
      initialFocus: '.modal-close',
      actions: [
        { label: 'Cancelar', variant: 'secondary', value: false },
        { label: 'Guardar cambios', variant: 'primary', icon: 'check', onClick: () => save() },
      ],
    });
    submitOnEnter(form, () => primaryAction(layer));
    renderPin();
    renderWarning();
    if (inUse > 0) void loadHeld();

    // Tools held ------------------------------------------------------------------

    async function loadHeld() {
      heldController?.abort();
      const mine = new AbortController();
      heldController = mine;
      if (!held) replace(heldBox, h('div.adm-held-note.small.subtle', 'Cargando sus útiles en uso…'));
      try {
        const result = await adminRequest('GET', '/admin/tools', { query: { status: 'in_use', limit: 500 }, signal: mine.signal });
        if (destroyed || heldController !== mine) return;
        held = (Array.isArray(result?.tools) ? result.tools : []).filter((tool) => tool.holder?.operatorId === op.id);
        inUse = held.length;
      } catch (err) {
        if (destroyed || heldController !== mine || err.code === 'ABORTED' || err.status === 401) return;
        if (!held) {
          replace(heldBox, h('div.adm-held-note.small.subtle', 'No se han podido cargar sus útiles en uso.'));
          return;
        }
      }
      renderHeld();
      renderSummaryMeta();
      renderWarning();
    }

    function renderHeld() {
      heldBox.hidden = !held || held.length === 0;
      if (heldBox.hidden) {
        replace(heldBox);
        return;
      }
      replace(
        heldBox,
        h(
          'div.adm-held-head',
          h('h3.adm-held-title', `Útiles en uso (${fmt.number(held.length)})`),
          button({
            label: held.length === 1 ? 'Devolver' : 'Devolver todos',
            icon: 'undo',
            variant: 'warning',
            size: 'sm',
            onClick: () => void returnAll(),
          }),
        ),
        h(
          'ul.adm-held-list',
          held.map((tool) =>
            h(
              'li.adm-held-item',
              h(
                'div.grow',
                h('div.adm-held-code', h('span.adm-code', tool.code), unitTag(tool), tool.active === false ? tag('De baja') : null),
                h(
                  'div.adm-held-loc',
                  { title: tool.location ? [tool.location, fmt.containerSentence(tool.container)].filter(Boolean).join('. ') : null },
                  tool.location || 'Sin ubicación',
                  tool.location ? containerHint(tool) : null,
                ),
              ),
              h('span.adm-held-time', liveDuration(tool.holder.since)),
              button({
                label: 'Devolver',
                variant: 'ghost',
                size: 'sm',
                ariaLabel: `Forzar la devolución de ${tool.code}`,
                title: `Forzar la devolución de ${tool.code}`,
                onClick: async () => {
                  if (await forceReturn(tool)) {
                    refreshSoon();
                    void loadHeld();
                  }
                },
              }),
            ),
          ),
        ),
      );
    }

    async function returnAll() {
      const count = held?.length ?? 0;
      if (!count) return;
      let returned = null;
      await ui.confirm({
        title: count === 1 ? `¿Devolver el útil de ${op.name}?` : `¿Devolver los ${fmt.number(count)} útiles de ${op.name}?`,
        message: h(
          'div.stack.stack-sm',
          h(
            'p',
            count === 1
              ? 'Se marcará como devuelto por administración y desaparecerá de su pestaña «Guardar».'
              : 'Se marcarán como devueltos por administración y desaparecerán de su pestaña «Guardar».',
          ),
          h(
            'p.small.subtle',
            count === 1
              ? 'Úsalo cuando ya esté en su sitio o el operario no pueda devolverlo.'
              : 'Úsalo cuando ya estén en su sitio o el operario no pueda devolverlos.',
          ),
        ),
        confirmLabel: count === 1 ? 'Devolver 1 útil' : `Devolver ${fmt.tools(count)}`,
        danger: true,
        icon: 'undo',
        tone: 'warning',
        onConfirm: async () => {
          try {
            const result = await adminRequest('POST', `/admin/operators/${encodeURIComponent(op.id)}/return-all`);
            returned = Number(result?.returned) || 0;
            return true;
          } catch (err) {
            if (err.status === 401) return true;
            reportError(err, 'No se han podido devolver sus útiles.');
            return err.status === 404;
          }
        },
      });
      if (returned === null) return;
      ui.toast(returned ? `${fmt.tools(returned)} de ${op.name} marcados como devueltos.` : `${op.name} ya no tenía útiles en uso.`, { type: 'success' });
      refreshSoon();
      void loadHeld();
    }

    function renderPin() {
      const mode = pinMode.value;
      pinField.hidden = mode !== 'change';
      pinNote.hidden = mode === 'keep';
      if (mode === 'change') requestAnimationFrame(() => pinEl.focus());
      else pinField.setError(null);
    }

    function renderWarning() {
      const deactivating = op.active && !activeSwitch.input.checked;
      const show = deactivating && inUse > 0;
      const wasHidden = warning.hidden;
      warning.hidden = !show;
      replace(warning, show ? heldToolsAlert(inUse) : '');
      if (show && wasHidden) warning.scrollIntoView({ block: 'nearest', behavior: ui.prefersReducedMotion() ? 'auto' : 'smooth' });
    }

    async function save() {
      nameField.setError(null);
      pinField.setError(null);
      const name = cleanText(nameEl.value);
      if (!name) {
        nameField.setError('Indica el nombre del operario.');
        nameEl.focus();
        return false;
      }
      const patch = {};
      if (name !== op.name) patch.name = name;
      const mode = pinMode.value;
      if (mode === 'change') {
        if (!PIN_RE.test(pinEl.value)) {
          pinField.setError('El PIN debe tener entre 4 y 6 dígitos.');
          pinEl.focus();
          return false;
        }
        patch.pin = pinEl.value;
      } else if (mode === 'remove') {
        patch.pin = null;
      }
      const active = activeSwitch.input.checked;
      if (active !== op.active) patch.active = active;
      if (Object.keys(patch).length === 0) return true;

      let returnHeld = false;
      if (patch.active === false) {
        const returnBox = inUse > 0 ? h('input', { type: 'checkbox', checked: true }) : null;
        const codes = (held ?? []).map((tool) => tool.code);
        const confirmed = await ui.confirm({
          title: `¿Desactivar a ${op.name}?`,
          message: h(
            'div.stack.stack-sm',
            h('p', 'No podrá entrar en la app y se cerrarán sus sesiones abiertas. Su historial se conserva y puedes reactivarlo cuando quieras.'),
            returnBox
              ? h(
                  'label.check.adm-confirm-check',
                  returnBox,
                  h(
                    'span.check-text',
                    h('span.check-title', inUse === 1 ? 'Devolver también su útil en uso' : `Devolver también sus ${fmt.tools(inUse)} en uso`),
                    codes.length
                      ? h(
                          'span.check-hint.adm-code-line',
                          codes.slice(0, 6).map((code, i) => [i ? ', ' : '', h('span.nowrap', code)]),
                          codes.length > 6 ? ` y ${fmt.number(codes.length - 6)} más` : '',
                        )
                      : null,
                    h('span.check-hint', 'Se marcarán como devueltos por administración. Si lo desmarcas, seguirán a su nombre hasta que fuerces la devolución.'),
                  ),
                )
              : null,
          ),
          confirmLabel: 'Desactivar',
          danger: true,
        });
        if (!confirmed) {
          // The confirmation was stacked on this panel: give the focus back to it.
          activeSwitch.input.focus();
          return false;
        }
        returnHeld = Boolean(returnBox?.checked);
      }

      try {
        const result = await adminRequest('PATCH', `/admin/operators/${encodeURIComponent(op.id)}`, { body: patch });
        const savedName = result?.operator?.name ?? name;
        let message = `${savedName}: cambios guardados.`;
        if (patch.active === false) message = `${savedName} desactivado.`;
        else if (patch.active === true) message = `${savedName} reactivado.`;
        else if (patch.pin === null) message = `PIN de ${savedName} eliminado.`;
        else if (patch.pin) message = `PIN de ${savedName} guardado. Tendrá que volver a identificarse en sus dispositivos.`;
        if (returnHeld) {
          try {
            const back = await adminRequest('POST', `/admin/operators/${encodeURIComponent(op.id)}/return-all`);
            const n = Number(back?.returned) || 0;
            if (n) message = `${savedName} desactivado y ${n === 1 ? 'su útil devuelto' : `sus ${fmt.tools(n)} devueltos`}.`;
          } catch (err) {
            if (err.status !== 401) {
              ui.toast(`${savedName} desactivado, pero no se han podido devolver sus útiles: ${err.message}`, { type: 'warning' });
              refreshSoon();
              return true;
            }
          }
        }
        ui.toast(message, { type: 'success' });
        refreshSoon();
        return true;
      } catch (err) {
        if (err.status === 401) return true;
        if (showFieldError(err, { nameField, nameEl, pinField, pinEl })) return false;
        if (err.status === 404) {
          ui.toast('Este operario ya no existe.', { type: 'warning' });
          refreshSoon();
          return true;
        }
        reportError(err, 'No se han podido guardar los cambios.');
        return false;
      }
    }
  }

  function heldToolsAlert(count) {
    return alertBox({
      type: 'warning',
      title: `Tiene ${fmt.tools(count)} en uso`,
      text: 'Al desactivarlo podrás devolverlos a la vez. Si no, seguirán a su nombre hasta que fuerces la devolución.',
    });
  }

  // Lifecycle -------------------------------------------------------------------------------

  return {
    onChange(event) {
      // Operators, their tools in use (checkouts / returns) and full resyncs.
      if (event.type !== 'tools' && event.type !== 'import') refreshSoon();
    },
    destroy() {
      destroyed = true;
      refreshSoon.cancel();
      controller?.abort();
    },
  };
}
