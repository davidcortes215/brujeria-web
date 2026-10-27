// #/admin sign-in (SPEC §3, §7): first-run setup (create the admin PIN twice) or login
// with the shared PIN pad. Wrong PINs and "attempts left" are shown by the pad itself
// (pinpad.js); the 429 lock-out (escalating, up to 15 min) is shown here as a countdown
// in minutes. The first PIN can only be created on the server PC (403 SETUP_LOCAL_ONLY):
// elsewhere the screen explains how to do it instead of showing the pad.

import { request } from '../api.js';
import { button } from '../components.js';
import { demoPin } from '../demo.js';
import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { createPinPad } from '../pinpad.js';
import { announce, toast, withBusy } from '../ui.js';
import { countdown, formatWait, isLocalHost } from './common.js';

const PIN_MIN = 4;
const PIN_MAX = 8;

/** Address of the administration on the server PC itself (same port as this page). */
function localAdminUrl() {
  const { protocol, port } = window.location;
  return `${protocol}//localhost${port ? `:${port}` : ''}/#/admin`;
}

/**
 * @param {HTMLElement} root
 * @param {object} o
 * @param {boolean} o.configured an admin PIN already exists (login) or not (setup)
 * @param {(token: string) => void} o.onToken receives the new admin session token
 * @returns {{ destroy(): void }}
 */
export function mountAuth(root, { configured, onToken }) {
  // 'login' | 'setup' | 'local' (setup is only possible on the server PC)
  let mode = configured ? 'login' : setupMode();
  let step = 1; // setup only: 1 = choose the PIN, 2 = repeat it
  let firstPin = '';
  let pad = null;
  let lockedUntil = 0; // login lock-out (429), ms timestamp
  let stopCountdown = null;
  let destroyed = false;

  const card = h('section.adm-auth-card', { 'aria-labelledby': 'adm-auth-title' });
  root.append(h('div.adm-auth', card));
  render();

  function setupMode() {
    return isLocalHost() ? 'setup' : 'local';
  }

  function render({ error = null, focus = false } = {}) {
    if (destroyed) return;
    pad?.destroy();
    pad = null;
    stopCountdown?.();
    stopCountdown = null;
    if (mode === 'local') {
      renderLocalOnly(focus);
      return;
    }
    const isSetup = mode === 'setup';
    const title = h(
      'h1.adm-auth-title#adm-auth-title',
      { tabIndex: -1 },
      isSetup ? 'Configura la administración' : 'Administración',
    );
    const text = isSetup
      ? 'Es la primera vez que se abre la administración. Crea un PIN de 4 a 8 dígitos: lo necesitarás para importar el catálogo, gestionar operarios y consultar el historial.'
      : 'Introduce el PIN de administración para continuar.';
    const locked = !isSetup && lockedUntil > Date.now();

    if (!locked) {
      pad = createPinPad({
        minLength: PIN_MIN,
        maxLength: PIN_MAX,
        label: isSetup ? (step === 1 ? 'Nuevo PIN de administración' : 'Repite el PIN de administración') : 'PIN de administración',
        hint: isSetup ? (step === 1 ? 'Elige entre 4 y 8 dígitos' : 'Repite el mismo PIN') : demoPin('admin') ? `PIN de la demo: ${demoPin('admin')}` : 'Introduce el PIN',
        onSubmit: isSetup ? submitSetup : submitLogin,
      });
    }

    replace(
      card,
      h('div.adm-auth-icon', { class: { 'is-setup': isSetup } }, icon(isSetup ? 'shield-check' : 'shield', { size: 26 })),
      title,
      h('p.adm-auth-text', text),
      isSetup
        ? h(
            'ol.adm-auth-steps',
            { 'aria-label': 'Pasos' },
            h('li', { class: { 'is-current': step === 1, 'is-done': step > 1 }, 'aria-current': step === 1 ? 'step' : null }, 'Nuevo PIN'),
            h('li', { class: { 'is-current': step === 2 }, 'aria-current': step === 2 ? 'step' : null }, 'Repetir PIN'),
          )
        : null,
      locked ? lockBox() : pad.el,
      isSetup && step === 2
        ? h('div.adm-auth-foot', button({ label: 'Empezar de nuevo', icon: 'undo', variant: 'ghost', size: 'sm', onClick: restart }))
        : h(
            'p.adm-auth-foot.small.subtle',
            isSetup
              ? 'Guarda el PIN en un lugar seguro: solo lo conoce quien lo crea.'
              : demoPin('admin')
                ? 'Los cambios de la demostración se guardan solo en este dispositivo.'
                : 'Si no conoces el PIN, pídeselo al responsable del taller.',
          ),
    );
    if (error) pad?.showError(error);
    if (focus) title.focus({ preventScroll: true });
  }

  /** Login lock-out: countdown in minutes; the pad comes back when it ends. */
  function lockBox() {
    const wait = h('span.adm-auth-lock-wait');
    const box = h(
      'div.adm-auth-lock',
      h('span.adm-auth-lock-icon', icon('clock', { size: 22 })),
      h(
        'div.adm-auth-lock-text',
        h('strong', 'Demasiados intentos fallidos'),
        h('span', 'Por seguridad, la entrada está bloqueada. Podrás volver a intentarlo en ', wait, '.'),
      ),
    );
    stopCountdown = countdown(
      (lockedUntil - Date.now()) / 1000,
      (left) => {
        wait.textContent = formatWait(left);
      },
      () => {
        stopCountdown = null;
        lockedUntil = 0;
        render();
        announce('Ya puedes volver a introducir el PIN.');
      },
    );
    return box;
  }

  /** Setup from another device: explain how to create the PIN on the server PC. */
  function renderLocalOnly(focus) {
    const title = h('h1.adm-auth-title#adm-auth-title', { tabIndex: -1 }, 'Configura la administración en el ordenador de Nevko');
    const url = localAdminUrl();
    const recheck = button({
      label: 'Ya está configurada',
      icon: 'refresh',
      onClick: (event) => void withBusy(event.currentTarget, recheckState),
    });
    replace(
      card,
      h('div.adm-auth-icon.is-setup', icon('monitor', { size: 26 })),
      title,
      h(
        'p.adm-auth-text',
        'Todavía no hay PIN de administración. Por seguridad, solo se puede crear desde el ordenador donde se ejecuta Nevko, no desde un móvil ni desde otro equipo.',
      ),
      h(
        'ol.adm-auth-guide',
        h('li', 'Ve al ordenador donde está en marcha Nevko (la ventana que dice «servidor en marcha»).'),
        h(
          'li',
          h('span', 'Abre el navegador en ese ordenador y entra en esta dirección:'),
          h('span.adm-auth-url', { title: url }, url),
        ),
        h('li', 'Crea allí el PIN. Después podrás entrar a la administración desde cualquier dispositivo con ese PIN.'),
      ),
      h('div.adm-auth-foot', recheck),
    );
    if (focus) title.focus({ preventScroll: true });
  }

  async function recheckState() {
    try {
      const state = await request('GET', '/admin/state', { auth: false, timeout: 8000 });
      if (destroyed) return;
      if (state?.configured) {
        mode = 'login';
        render({ focus: true });
        announce('El PIN ya está creado. Introdúcelo para entrar.');
      } else {
        toast('Todavía no se ha creado el PIN de administración. Créalo desde el ordenador de Nevko.', { type: 'info' });
      }
    } catch (err) {
      if (!destroyed) toast(err.message || 'No se ha podido comprobar.', { type: 'error' });
    }
  }

  function restart() {
    step = 1;
    firstPin = '';
    render({ focus: true });
    announce('Paso 1 de 2: elige el nuevo PIN');
  }

  function switchTo(next) {
    mode = next === 'setup' ? setupMode() : next;
    step = 1;
    firstPin = '';
    render({ focus: true });
  }

  async function submitLogin(pin) {
    try {
      const data = await request('POST', '/admin/login', { body: { pin }, auth: false });
      finish(data?.token);
    } catch (err) {
      if (err.code === 'NOT_CONFIGURED') {
        switchTo('setup');
        return;
      }
      const wait = Number(err.data?.retryAfter);
      if (err.status === 429 && wait > 0) {
        lockedUntil = Date.now() + wait * 1000;
        render();
        announce(`Demasiados intentos fallidos. Podrás volver a intentarlo en ${formatWait(wait)}.`);
        return;
      }
      throw err; // the pad shows it (wrong PIN, attempts left, network)
    }
  }

  async function submitSetup(pin) {
    if (step === 1) {
      firstPin = pin;
      step = 2;
      render();
      announce('Paso 2 de 2: repite el PIN');
      return;
    }
    if (pin !== firstPin) {
      step = 1;
      firstPin = '';
      render({ error: 'Los PIN no coinciden. Vuelve a elegirlo.' });
      return;
    }
    try {
      const data = await request('POST', '/admin/setup', { body: { pin }, auth: false });
      finish(data?.token);
    } catch (err) {
      if (err.code === 'ALREADY_CONFIGURED') {
        toast('La administración ya tiene un PIN. Introdúcelo para entrar.', { type: 'info' });
        switchTo('login');
        return;
      }
      if (err.code === 'SETUP_LOCAL_ONLY') {
        switchTo('local');
        return;
      }
      if (err.code === 'PIN_FORMAT') {
        step = 1;
        firstPin = '';
        render({ error: err.message });
        return;
      }
      throw err;
    }
  }

  function finish(token) {
    if (destroyed || !token) return;
    firstPin = '';
    onToken(token);
  }

  return {
    focus() {
      card.querySelector('#adm-auth-title')?.focus({ preventScroll: true });
    },
    destroy() {
      destroyed = true;
      pad?.destroy();
      pad = null;
      stopCountdown?.();
      stopCountdown = null;
    },
  };
}
