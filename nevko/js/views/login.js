// #/entrar — "¿Quién eres?" (SPEC §7): grid of operator cards, filter when there are
// many operators, and the numeric PIN pad for operators that have a PIN.
//
// The PIN step is not a separate route: it captures the back button (ui.captureBack),
// so Android "back" returns to the grid instead of leaving the screen.

import { api } from '../api.js';
import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, button, emptyState, errorState, pageHeader, skeleton } from '../components.js';
import { demoPin } from '../demo.js';
import { textNorm } from '../normalize.js';
import { createPinPad } from '../pinpad.js';
import { router } from '../router.js';
import { currentOperator, isSignedIn, signIn } from '../session.js';
import { announce, captureBack, toast, toastError } from '../ui.js';

const FILTER_THRESHOLD = 12;
const PIN_MIN = 4;
const PIN_MAX = 6;
const LIVE_REFRESH_TYPES = new Set(['operators', 'resync']);
const NEXT_PATH = /^\/(buscar|lista|guardar|util\/\d+)$/;

/** Last operator list, shown instantly on the next visit while it is refreshed. */
let cachedOperators = null;

/** Where to go after signing in: ?next=/util/12 (operator routes only) or Buscar. */
function destination(route) {
  const next = route.query?.next;
  return typeof next === 'string' && NEXT_PATH.test(next) ? next : '/buscar';
}

export function mountLogin(root, { route }) {
  document.title = 'Entrar · Nevko';

  let operators = cachedOperators;
  let loadError = null;
  let filter = '';
  let selected = null; // operator whose PIN is being entered
  let pad = null;
  let back = null; // back-button capture while the PIN step is shown
  let busyId = null; // operator being signed in without PIN
  let destroyed = false;
  let loadSeq = 0;

  const view = h('div.view.login');
  root.append(view);

  renderGrid();
  void load();

  // Data -----------------------------------------------------------------------

  async function load({ silent = false } = {}) {
    const mySeq = ++loadSeq;
    try {
      const data = await api.operators();
      if (destroyed || mySeq !== loadSeq) return;
      operators = Array.isArray(data?.operators) ? data.operators : [];
      cachedOperators = operators;
      loadError = null;
    } catch (err) {
      if (destroyed || mySeq !== loadSeq || err.code === 'ABORTED') return;
      if (operators && silent) return; // keep showing the last list
      loadError = err;
    }
    if (selected) {
      const fresh = operators?.find((op) => op.id === selected.id);
      if (!fresh) {
        toast(`${selected.name} ya no está disponible. Elige otro operario.`, { type: 'warning' });
        await leavePin();
        return;
      }
      selected = fresh;
      return; // stay on the PIN step
    }
    renderGrid();
  }

  // Grid -----------------------------------------------------------------------

  function renderGrid() {
    if (destroyed) return;
    const hadFilterFocus = document.activeElement?.id === 'op-filter';
    const signedIn = isSignedIn();

    const header = pageHeader({
      title: '¿Quién eres?',
      subtitle: signedIn ? 'Elige tu nombre para cambiar de operario.' : 'Toca tu nombre para empezar.',
      id: 'login-title',
    });

    let body;
    if (loadError && !operators) {
      body = errorState(
        loadError,
        () => {
          loadError = null;
          renderGrid();
          void load();
        },
        { title: 'No se ha podido cargar la lista de operarios' },
      );
    } else if (!operators) {
      body = skeleton(6, 'operator');
    } else if (operators.length === 0) {
      body = emptyState({
        icon: 'users',
        title: 'Todavía no hay operarios',
        text: 'El responsable del taller debe darlos de alta desde Administración.',
        action: button({ label: 'Ir a Administración', icon: 'shield', href: '#/admin' }),
      });
    } else {
      body = operatorList();
    }

    replace(
      view,
      signedIn ? h('div.subheader', button({ icon: 'arrow-left', label: 'Volver', variant: 'ghost', onClick: () => router.back('/buscar') })) : null,
      h('div.login-body', header, body),
      h(
        'div.login-footer',
        h('a.btn.btn-ghost.btn-sm', { href: '#/admin' }, icon('shield', { size: 16 }), h('span.btn-label', 'Administración')),
      ),
    );
    if (hadFilterFocus) {
      const input = view.querySelector('#op-filter');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function operatorList() {
    const showFilter = operators.length > FILTER_THRESHOLD;
    const grid = h('ul.op-grid', { 'aria-labelledby': 'login-title' });
    const noMatch = h('div', { hidden: true });

    const applyFilter = () => {
      const needle = textNorm(filter);
      const matches = needle ? operators.filter((op) => textNorm(op.name).includes(needle)) : operators;
      grid.replaceChildren(...matches.map(operatorCard));
      grid.hidden = matches.length === 0;
      noMatch.hidden = matches.length > 0;
      noMatch.replaceChildren(
        matches.length
          ? ''
          : emptyState({ icon: 'search-x', title: `Ningún operario coincide con «${filter.trim()}»`, compact: true }),
      );
    };
    applyFilter();

    if (!showFilter) return grid;

    const input = h('input.input#op-filter', {
      type: 'search',
      value: filter,
      placeholder: 'Buscar por nombre',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      'aria-label': 'Filtrar operarios por nombre',
      onInput: () => {
        filter = input.value;
        applyFilter();
      },
      onKeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const cards = grid.querySelectorAll('.op-card');
        if (cards.length === 1) cards[0].click(); // a single match: pick it
        else input.blur();
      },
    });
    return h('div', h('div.op-filter.input-group', icon('search'), input), grid, noMatch);
  }

  function operatorCard(op) {
    const current = currentOperator()?.id === op.id && isSignedIn();
    return h(
      'li',
      h(
        'button.op-card',
        {
          type: 'button',
          class: { 'is-current': current, 'is-loading': busyId === op.id },
          dataset: { operatorId: op.id },
          disabled: busyId !== null,
          'aria-label': `${op.name}${op.hasPin ? ', con PIN' : ''}${current ? ', sesión actual' : ''}`,
          onClick: () => void choose(op),
        },
        avatar(op.name, { size: 'lg' }),
        h('span.op-card-name', op.name),
        op.hasPin ? h('span.op-card-lock', { 'aria-hidden': 'true' }, icon('lock', { size: 16 })) : null,
      ),
    );
  }

  async function choose(op) {
    if (busyId !== null || destroyed) return;
    if (op.hasPin) {
      showPin(op);
      return;
    }
    busyId = op.id;
    renderGrid();
    try {
      const result = await api.login(op.id);
      await finish(result);
    } catch (err) {
      busyId = null;
      if (destroyed) return;
      if (err.code === 'PIN_REQUIRED') {
        // A PIN was added meanwhile: ask for it.
        showPin({ ...op, hasPin: true });
        void load({ silent: true });
        return;
      }
      if (err.code === 'OPERATOR_NOT_FOUND') {
        toast(err.message, { type: 'warning' });
        void load({ silent: true });
      } else {
        toastError(err);
      }
      renderGrid();
    }
  }

  // PIN step -------------------------------------------------------------------

  function showPin(op) {
    selected = op;
    if (!back) {
      back = captureBack(() => {
        back = null;
        closePin();
      });
    }
    pad?.destroy();
    pad = createPinPad({
      minLength: PIN_MIN,
      maxLength: PIN_MAX,
      label: `PIN de ${op.name}`,
      hint: demoPin(op.id) ? `PIN de la demo: ${demoPin(op.id)}` : 'Introduce tu PIN',
      onSubmit: (pin) => submitPin(op, pin),
    });
    const title = h('h1.pin-step-name#pin-title', { tabIndex: -1 }, op.name);
    view.replaceChildren(
      h(
        'div.subheader',
        button({ icon: 'arrow-left', label: 'Cambiar de operario', variant: 'ghost', onClick: () => void leavePin() }),
      ),
      h('div.login-body', h('section.pin-step', { 'aria-labelledby': 'pin-title' }, avatar(op.name, { size: 'xl' }), title, pad.el)),
    );
    window.scrollTo({ top: 0 });
    title.focus({ preventScroll: true });
    announce(`PIN de ${op.name}`);
  }

  async function submitPin(op, pin) {
    let result;
    try {
      result = await api.login(op.id, pin);
    } catch (err) {
      if (err.code === 'OPERATOR_NOT_FOUND') {
        toast(err.message, { type: 'warning' });
        await leavePin();
        void load({ silent: true });
        return;
      }
      throw err; // the pad shows it (wrong PIN, attempts left, lock-out countdown, network)
    }
    await finish(result);
  }

  /** Back to the grid from the PIN step (removes the back-button capture). */
  async function leavePin() {
    const capture = back;
    back = null;
    closePin();
    await capture?.release();
  }

  function closePin() {
    pad?.destroy();
    pad = null;
    const previous = selected;
    selected = null;
    renderGrid();
    if (previous) view.querySelector(`.op-card[data-operator-id="${previous.id}"]`)?.focus({ preventScroll: true });
  }

  // Signed in ------------------------------------------------------------------

  async function finish(result) {
    if (destroyed) return;
    signIn(result);
    const capture = back;
    back = null;
    await capture?.release(); // leave no PIN-step entry in the history
    if (destroyed) return;
    toast(`Has entrado como ${result.operator.name}`, { type: 'success' });
    const target = destination(route);
    if (router.previousPath() === target) router.back(target);
    else router.navigate(target, { replace: true });
  }

  // Lifecycle --------------------------------------------------------------------

  return {
    onChange(event) {
      if (LIVE_REFRESH_TYPES.has(event.type)) void load({ silent: true });
    },
    focusTitle() {
      view.querySelector('#pin-title, #login-title')?.focus({ preventScroll: true });
    },
    destroy() {
      destroyed = true;
      pad?.destroy();
      pad = null;
      // A capture still pending here means the route changed under the PIN step
      // (main closes overlays and forgets captures on every route change).
      back = null;
    },
  };
}
