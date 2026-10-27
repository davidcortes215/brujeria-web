// #/admin/utiles — the catalogue: debounced search, status filter (Todos / En uso /
// Disponibles / Bajas), paginated table (100 per page), edit panel (code, location,
// description, active, force return) and the "Nuevo útil" dialog. A code can have several
// units (one tool per physical unit, "Unidad 2 de 3"): a code that already exists (409
// CODE_EXISTS with data.canAddUnit) asks "Ya existe X en Y. ¿Añadir otra unidad?" and repeats
// the request with allowDuplicate: true; if not, or for the same code written differently
// (data.similar + toolCode, never a new unit), the error is shown on the code field, with a
// shortcut to the existing tool. A location inside a kit ("INCLUIDO EN VAT 8015") shows
// where the kit is, muted: "(en AR1)". "En uso" also lists
// tools retired while someone holds them ("De baja" + "En uso · Nombre"). The CSV export
// contains the active tools only (Ajustes can include the retired ones).

import { alertBox, avatar, button, containerHint, emptyState, field, input, segmented, unitTag } from '../components.js';
import { clear, h, highlight, replace } from '../dom.js';
import * as fmt from '../fmt.js';
import { icon } from '../icons.js';
import { cleanText } from '../normalize.js';
import * as ui from '../ui.js';
import {
  adminRequest,
  clickableRow,
  dataTable,
  debounce,
  downloadAdminFile,
  forceReturn,
  inlineError,
  liveDuration,
  pageHeader,
  pagination,
  primaryAction,
  reportError,
  submitOnEnter,
  switchControl,
  tableSkeleton,
  toolPills,
} from './common.js';

const PAGE_SIZE = 100;
const SEARCH_DELAY_MS = 250;
const REFRESH_DELAY_MS = 300;
const LIMITS = { code: 80, location: 200, description: 1000 };

const STATUS_OPTIONS = [
  { value: 'all', label: 'Todos' },
  { value: 'in_use', label: 'En uso' },
  { value: 'available', label: 'Disponibles' },
  { value: 'inactive', label: 'Bajas' },
];

const EMPTY_TEXT = {
  in_use: 'Ningún útil está en uso ahora mismo.',
  available: 'No hay útiles disponibles: todos están en uso o de baja.',
  inactive: 'No hay útiles dados de baja.',
};

export function mountTools(root, env) {
  const state = env.store;
  state.q ??= '';
  state.status ??= 'all';
  state.offset ??= 0;
  const intent = state.intent;
  state.intent = null;
  if (intent?.q !== undefined) {
    state.q = intent.q;
    state.status = 'all';
    state.offset = 0;
  }

  let data = null;
  let error = null;
  let controller = null;
  let destroyed = false;
  let editor = null; // open edit panel: { id, sync(tools) }

  // Header & toolbar --------------------------------------------------------------

  const exportButton = button({
    label: 'Exportar CSV',
    icon: 'download',
    title: 'Descarga los útiles activos en CSV (los dados de baja se pueden incluir desde Ajustes)',
    onClick: () => void exportCsv(),
  });
  const header = pageHeader({
    title: 'Útiles',
    subtitle: 'Catálogo de utillaje con su ubicación y estado.',
    actions: [exportButton, button({ label: 'Nuevo útil', icon: 'plus', variant: 'primary', onClick: () => openCreator() })],
  });

  const search = h('input.input', {
    type: 'search',
    value: state.q,
    placeholder: 'Buscar por código, ubicación o descripción',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-label': 'Buscar útiles',
    onInput: () => searchSoon(),
    onKeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchSoon.cancel();
        applySearch();
      }
    },
  });
  const statusFilter = segmented({
    label: 'Filtrar por estado',
    options: STATUS_OPTIONS,
    value: state.status,
    onChange: (value) => {
      state.status = value;
      state.offset = 0;
      void load();
    },
  });

  const results = h('div.adm-results');
  const pager = h('div');

  root.append(
    header.el,
    h('div.toolbar.adm-toolbar', h('div.toolbar-grow.input-group', icon('search'), search), statusFilter),
    results,
    pager,
  );

  const searchSoon = debounce(applySearch, SEARCH_DELAY_MS);
  const refreshSoon = debounce(() => void load({ silent: true }), REFRESH_DELAY_MS);

  render();
  void load();
  if (intent?.create) requestAnimationFrame(() => !destroyed && openCreator());
  else if (intent?.edit) requestAnimationFrame(() => !destroyed && openEditor(intent.edit));

  // Data ------------------------------------------------------------------------

  function applySearch() {
    const q = search.value.trim();
    if (q === state.q.trim()) return;
    state.q = q;
    state.offset = 0;
    void load();
  }

  async function load({ silent = false } = {}) {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    if (!silent) results.classList.add('is-busy');
    try {
      const result = await adminRequest('GET', '/admin/tools', {
        query: { q: state.q.trim(), status: state.status, offset: state.offset, limit: PAGE_SIZE },
        signal: mine.signal,
      });
      if (destroyed || controller !== mine) return;
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      if (tools.length === 0 && result.total > 0 && state.offset > 0) {
        // The page no longer exists (fewer tools now): show the last one.
        state.offset = Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE;
        void load({ silent });
        return;
      }
      data = { total: Number(result?.total) || 0, tools };
      error = null;
      editor?.sync(tools);
    } catch (err) {
      if (destroyed || controller !== mine || err.code === 'ABORTED' || err.status === 401) return;
      if (silent && data) return; // keep the current list; the next change retries
      error = err;
    } finally {
      if (controller === mine) results.classList.remove('is-busy');
    }
    render();
  }

  // Rendering -----------------------------------------------------------------------

  function render() {
    if (destroyed) return;
    results.setAttribute('aria-busy', String(!data && !error));
    if (!data) {
      replace(results, error ? h('div.card', inlineError(error, retry)) : h('div.card', tableSkeleton(8, 4)));
      clear(pager);
      return;
    }
    const { total, tools } = data;
    const q = state.q.trim();
    if (total === 0) {
      replace(results, h('div.card', emptyContent(q)));
      clear(pager);
      return;
    }
    replace(results, h('div.table-wrap', toolTable(tools, q)));
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

  function emptyContent(q) {
    if (q) {
      return emptyState({
        icon: 'search-x',
        title: `No hay útiles que coincidan con «${q}»`,
        text: state.status === 'all' ? 'Prueba con otra parte del código o de la ubicación.' : 'Prueba con otro filtro de estado o con otra búsqueda.',
        compact: true,
      });
    }
    if (state.status === 'all') {
      return emptyState({
        icon: 'package',
        title: 'El catálogo está vacío',
        text: 'Importa el listado de utillaje en PDF o CSV, o da de alta los útiles a mano.',
        action: h(
          'div.btn-group.adm-center',
          button({ label: 'Importar catálogo', icon: 'upload', variant: 'primary', href: '#/admin/importar' }),
          button({ label: 'Nuevo útil', icon: 'plus', onClick: () => openCreator() }),
        ),
      });
    }
    return emptyState({ icon: 'inbox', title: EMPTY_TEXT[state.status] ?? 'No hay útiles.', compact: true });
  }

  function toolTable(tools, q) {
    return dataTable({
      caption: 'Útiles del catálogo',
      rows: tools,
      rowProps: (tool) => {
        const props = clickableRow(() => openEditor(tool));
        return { ...props, class: ['is-clickable', tool.active === false && 'is-muted'] };
      },
      columns: [
        {
          label: 'Código',
          primary: true,
          className: 'adm-col-code',
          cell: (tool) =>
            h(
              'div.adm-tool-cell',
              h(
                'button.adm-link.adm-code',
                { type: 'button', 'aria-label': `Editar ${fmt.codeWithUnit(tool)}`, onClick: () => openEditor(tool) },
                highlight(tool.code, q, { mode: 'code' }),
              ),
              unitTag(tool),
            ),
        },
        {
          label: 'Ubicación',
          className: 'adm-col-loc',
          cell: (tool) =>
            tool.location ? [highlight(tool.location, q, { mode: 'text' }), containerHint(tool)] : h('span.subtle', '—'),
        },
        {
          label: 'Descripción',
          className: 'adm-col-desc',
          cell: (tool) =>
            tool.description ? h('span.adm-clamp', highlight(tool.description, q, { mode: 'text' })) : h('span.subtle', '—'),
        },
        { label: 'Estado', className: 'adm-col-status', cell: (tool) => toolPills(tool) },
        {
          label: '',
          srLabel: 'Abrir',
          className: 'adm-col-chevron',
          cell: () => icon('chevron-right', { size: 18, className: 'icon-chevron' }),
        },
      ],
    });
  }

  async function exportCsv() {
    await ui.withBusy(exportButton, async () => {
      try {
        const name = await downloadAdminFile('/admin/export.csv', 'nevko-utiles.csv');
        ui.toast(`Descargado ${name} con los útiles activos. Para incluir los dados de baja, expórtalo desde Ajustes.`, {
          type: 'success',
          duration: 6000,
        });
      } catch (err) {
        reportError(err, 'No se ha podido exportar el catálogo.');
      }
    });
  }

  // Edit panel ---------------------------------------------------------------------

  function toolFields(tool = { code: '', location: '', description: '' }) {
    const code = input({
      value: tool.code,
      mono: true,
      attrs: { maxlength: String(LIMITS.code), autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', required: true },
    });
    const location = input({ value: tool.location, attrs: { maxlength: String(LIMITS.location), autocomplete: 'off' } });
    const description = h('textarea.textarea', {
      value: tool.description,
      rows: 3,
      maxlength: String(LIMITS.description),
    });
    const codeField = field({ label: 'Código', control: code });
    const existing = h('div.adm-field-action', { hidden: true });
    codeField.append(existing);
    return {
      code,
      location,
      description,
      codeField,
      existing,
      locationField: field({ label: 'Ubicación', control: location, hint: 'Dónde se guarda. Es lo que el operario ve en grande.' }),
      descriptionField: field({ label: 'Descripción', control: description, optional: true }),
      values() {
        return { code: cleanText(code.value), location: cleanText(location.value), description: cleanText(description.value) };
      },
      clearErrors() {
        codeField.setError(null);
        existing.hidden = true;
        clear(existing);
      },
    };
  }

  /** 409 CODE_EXISTS that the admin may accept as one more unit of that code (not "written differently"). */
  function isNewUnitConflict(err) {
    return err?.code === 'CODE_EXISTS' && err.data?.canAddUnit === true && !err.data?.similar;
  }

  /**
   * "Ya existe VAS 6056 en X. ¿Añadir otra unidad?" (the server's message says where the
   * existing units are). `editing`: an existing tool whose new code another tool has.
   */
  function confirmNewUnit(err, { editing = false } = {}) {
    const code = err.data?.toolCode || '';
    const locations = Array.isArray(err.data?.locations) ? err.data.locations.filter(Boolean) : [];
    return ui.confirm({
      title: editing ? `¿Pasar a ser otra unidad de ${code}?` : 'Ya existe ese código',
      icon: 'copy',
      message: h(
        'div.stack.stack-sm',
        h('p', `${err.message} ${editing ? '¿Convertirlo en otra unidad?' : '¿Añadir otra unidad?'}`),
        locations.length > 1 ? h('p.small', 'Están en: ', h('strong', locations.join(' · '))) : null,
        h(
          'p.small.subtle',
          editing
            ? `Este útil pasará a ser una unidad más de ${code}, con su propia ubicación, su estado y su historial.`
            : 'Cada unidad es un útil aparte, con su propia ubicación, su estado y su historial.',
        ),
      ),
      confirmLabel: editing ? 'Sí, otra unidad' : 'Añadir otra unidad',
    });
  }

  /** Shows a server validation error on the code field. Returns true when handled. */
  function showCodeError(err, fields, layer) {
    if (!['CODE_EXISTS', 'CODE_REQUIRED', 'CODE_INVALID'].includes(err.code)) return false;
    fields.codeField.setError(err.message);
    fields.code.focus();
    const otherId = err.data?.toolId;
    if (err.code === 'CODE_EXISTS' && otherId) {
      // similar: the same code written differently ("CAL 009" for CAL-009); toolCode is its spelling.
      const otherCode = typeof err.data.toolCode === 'string' && err.data.toolCode ? err.data.toolCode : null;
      let label = err.data.active === false ? 'Abrir el útil dado de baja' : 'Abrir el útil existente';
      if (err.data.similar && otherCode) label = `Abrir ${otherCode}`;
      fields.existing.hidden = false;
      replace(
        fields.existing,
        button({
          label,
          icon: 'arrow-right',
          variant: 'ghost',
          size: 'sm',
          onClick: async () => {
            const other = await findTool(otherId, otherCode ?? fields.values().code);
            if (!other) {
              ui.toast('No se ha encontrado ese útil.', { type: 'warning' });
              return;
            }
            await layer.close(false);
            openEditor(other);
          },
        }),
      );
    }
    return true;
  }

  async function findTool(id, code) {
    try {
      const result = await adminRequest('GET', '/admin/tools', { query: { q: code, status: 'all', limit: 50 } });
      return result?.tools?.find((tool) => tool.id === id) ?? null;
    } catch (err) {
      reportError(err);
      return null;
    }
  }

  function openEditor(tool) {
    let current = tool;
    const fields = toolFields(tool);
    const activeSwitch = switchControl({
      checked: tool.active !== false,
      label: 'Útil activo',
      hint: 'Los útiles dados de baja no aparecen en la búsqueda de los operarios. Se conserva su historial.',
      onChange: () => renderWarning(),
    });
    const statusBox = h('div.adm-tool-status', { tabIndex: -1 });
    const warning = h('div', { hidden: true });
    const form = h(
      'form.form',
      { noValidate: true },
      statusBox,
      fields.codeField,
      fields.locationField,
      fields.descriptionField,
      h('div.adm-switch-row', activeSwitch.el),
      warning,
    );

    const layer = ui.panel({
      title: 'Editar útil',
      description: fmt.unitLabel(tool) ? `${tool.code} · ${fmt.unitLabel(tool)}` : tool.code,
      content: form,
      className: 'adm-layer',
      initialFocus: '.modal-close',
      actions: [
        { label: 'Cancelar', variant: 'secondary', value: false },
        { label: 'Guardar cambios', variant: 'primary', icon: 'check', onClick: () => save() },
      ],
      onClose: () => {
        if (editor?.id === tool.id) editor = null;
      },
    });
    submitOnEnter(form, () => primaryAction(layer));
    renderStatus();
    renderWarning();

    editor = {
      id: tool.id,
      sync(tools) {
        const fresh = tools.find((t) => t.id === current.id);
        if (!fresh) return;
        const changed = (fresh.holder?.operatorId ?? null) !== (current.holder?.operatorId ?? null) || fresh.active !== current.active;
        current = fresh;
        if (changed) {
          renderStatus();
          renderWarning();
        }
      },
    };

    function renderStatus() {
      const t = current;
      replace(
        statusBox,
        h('div.adm-tool-status-head', toolPills(t), unitTag(t)),
        t.container ? h('p.small.subtle.adm-tool-kit', `${fmt.containerSentence(t.container)}.`) : null,
        t.holder
          ? h(
              'div.adm-holder',
              avatar(t.holder.name, { size: 'sm' }),
              h(
                'div.grow',
                h('div.adm-holder-name', t.holder.name),
                h('div.adm-holder-meta', `Desde ${fmt.dateTime(t.holder.since)} · `, liveDuration(t.holder.since)),
              ),
              button({
                label: 'Forzar devolución',
                icon: 'undo',
                variant: 'warning',
                size: 'sm',
                onClick: async (event) => {
                  const trigger = event.currentTarget;
                  if (await forceReturn(t)) {
                    current = { ...current, holder: null };
                    renderStatus();
                    renderWarning();
                    refreshSoon();
                    statusBox.focus({ preventScroll: true }); // the button is gone: keep focus in the panel
                  } else {
                    trigger.focus();
                  }
                },
              }),
            )
          : null,
        h(
          'div.adm-tool-status-links',
          button({
            label: 'Ver historial de este útil',
            icon: 'history',
            variant: 'ghost',
            size: 'sm',
            onClick: () => env.go('historial', { q: current.code }),
          }),
        ),
      );
    }

    function renderWarning() {
      const deactivating = !activeSwitch.input.checked && current.active !== false;
      const show = deactivating && current.holder;
      const wasHidden = warning.hidden;
      warning.hidden = !show;
      replace(
        warning,
        show
          ? alertBox({
              type: 'warning',
              title: `Lo tiene ${current.holder.name}`,
              text: 'Al darlo de baja seguirá a su nombre hasta que lo devuelva o fuerces la devolución.',
            })
          : '',
      );
      if (show && wasHidden) warning.scrollIntoView({ block: 'nearest', behavior: ui.prefersReducedMotion() ? 'auto' : 'smooth' });
    }

    async function save() {
      fields.clearErrors();
      const values = fields.values();
      if (!values.code) {
        fields.codeField.setError('Indica el código del útil.');
        fields.code.focus();
        return false;
      }
      const patch = {};
      if (values.code !== current.code) patch.code = values.code;
      if (values.location !== current.location) patch.location = values.location;
      if (values.description !== current.description) patch.description = values.description;
      const active = activeSwitch.input.checked;
      if (active !== (current.active !== false)) patch.active = active;
      if (Object.keys(patch).length === 0) return true;
      let body = patch;
      for (;;) {
        try {
          const result = await adminRequest('PATCH', `/admin/tools/${encodeURIComponent(current.id)}`, { body });
          const saved = result?.tool ?? { ...current, ...patch };
          let message = `${saved.code} guardado.`;
          if (patch.active === false) message = `${saved.code} dado de baja.`;
          else if (patch.active === true) message = `${saved.code} reactivado.`;
          ui.toast(message, { type: 'success' });
          refreshSoon();
          return true;
        } catch (err) {
          if (err.status === 401) return true;
          // The new code is another tool's: confirm it as one more unit of that code.
          if (!body.allowDuplicate && isNewUnitConflict(err) && (await confirmNewUnit(err, { editing: true }))) {
            body = { ...patch, allowDuplicate: true };
            continue;
          }
          if (showCodeError(err, fields, layer)) return false;
          if (err.status === 404) {
            ui.toast('Este útil ya no existe.', { type: 'warning' });
            refreshSoon();
            return true;
          }
          reportError(err, 'No se han podido guardar los cambios.');
          return false;
        }
      }
    }
  }

  // "Nuevo útil" ------------------------------------------------------------------------

  function openCreator() {
    const fields = toolFields();
    const form = h(
      'form.form',
      { noValidate: true },
      fields.codeField,
      fields.locationField,
      fields.descriptionField,
    );
    const layer = ui.dialog({
      title: 'Nuevo útil',
      description: 'Alta manual en el catálogo. Para cargar muchos útiles a la vez usa Importar.',
      icon: 'plus',
      content: form,
      className: 'adm-layer',
      actions: [
        { label: 'Cancelar', variant: 'secondary', value: false },
        { label: 'Crear útil', variant: 'primary', icon: 'check', onClick: () => create() },
      ],
    });
    submitOnEnter(form, () => primaryAction(layer));

    async function create() {
      fields.clearErrors();
      const values = fields.values();
      if (!values.code) {
        fields.codeField.setError('Indica el código del útil.');
        fields.code.focus();
        return false;
      }
      let body = values;
      for (;;) {
        try {
          const result = await adminRequest('POST', '/admin/tools', { body });
          const created = result?.tool ?? values;
          const unit = fmt.unitLabel(created);
          ui.toast(`${created.code || values.code} añadido al catálogo${unit ? ` (${unit.toLowerCase()})` : ''}.`, { type: 'success' });
          refreshSoon();
          return true;
        } catch (err) {
          if (err.status === 401) return true;
          // The code already exists: confirm one more unit of it.
          if (!body.allowDuplicate && isNewUnitConflict(err) && (await confirmNewUnit(err))) {
            body = { ...values, allowDuplicate: true };
            continue;
          }
          if (showCodeError(err, fields, layer)) return false;
          reportError(err, 'No se ha podido crear el útil.');
          return false;
        }
      }
    }
  }

  // Lifecycle ---------------------------------------------------------------------------

  return {
    onChange() {
      refreshSoon();
    },
    destroy() {
      destroyed = true;
      searchSoon.cancel();
      refreshSoon.cancel();
      controller?.abort();
      editor = null;
    },
  };
}

