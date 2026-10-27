// Numeric PIN pad with progress dots (large keys, usable with gloves).
// The system keyboard is never shown; a physical keyboard also works (digits,
// Backspace, Enter) while the pad is in the page.
//
//   const pad = createPinPad({ minLength: 4, maxLength: 6, onSubmit: async (pin) => { ... } });
//   container.append(pad.el);
//   ...
//   pad.destroy();   // removes the keyboard listener
//
// onSubmit may throw an ApiError-like object: the pad shakes, vibrates, shows `message`
// (plus "Te quedan N intentos" when data.attemptsLeft is given) and clears the digits.
// An error with data.retryAfter (429) locks the pad with a countdown.

import { h } from './dom.js';
import * as fmt from './fmt.js';
import { icon } from './icons.js';
import { vibrate } from './ui.js';

/**
 * @param {object} o
 * @param {number} [o.minLength=4]
 * @param {number} [o.maxLength=6]
 * @param {(pin:string)=>Promise<void>} o.onSubmit
 * @param {string} [o.label='PIN'] accessible name of the pad
 * @param {string} [o.hint] idle message under the dots
 * @param {boolean} [o.autoSubmit=false] submit automatically when maxLength digits are entered
 */
export function createPinPad({ minLength = 4, maxLength = 6, onSubmit, label = 'PIN', hint = '', autoSubmit = false } = {}) {
  let digits = '';
  let busy = false;
  let locked = false;
  let lockTimer = null;
  let errorTimer = null;
  let destroyed = false;

  const dots = h('div.pin-dots', { 'aria-hidden': 'true' });
  const status = h('span.sr-only', { 'aria-live': 'polite' });
  const message = h('div.pin-message', { 'aria-live': 'assertive' }, hint);

  const digitKey = (d) =>
    h('button.pin-key', { type: 'button', dataset: { digit: d }, 'aria-label': d, onClick: () => press(d) }, d);

  const deleteKey = h(
    'button.pin-key.pin-key-aux',
    { type: 'button', 'aria-label': 'Borrar último dígito', onClick: () => backspace() },
    icon('delete', { size: 26 }),
  );
  const submitKey = h(
    'button.pin-key.pin-key-submit',
    { type: 'button', 'aria-label': 'Entrar', onClick: () => void submit() },
    icon('check', { size: 28, strokeWidth: 2.5 }),
  );

  const keys = h(
    'div.pin-keys',
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digitKey),
    deleteKey,
    digitKey('0'),
    submitKey,
  );

  const el = h('div.pin', { role: 'group', 'aria-label': label }, dots, status, message, keys);

  function render() {
    const slots = Math.max(minLength, digits.length);
    dots.replaceChildren(
      ...Array.from({ length: slots }, (_, i) => h('span.pin-dot', { class: { 'is-filled': i < digits.length } })),
    );
    status.textContent = digits.length ? `${digits.length} ${digits.length === 1 ? 'dígito' : 'dígitos'}` : '';
    const disabled = busy || locked;
    for (const btn of keys.querySelectorAll('button')) btn.disabled = disabled;
    deleteKey.disabled = disabled || digits.length === 0;
    submitKey.disabled = disabled || digits.length < minLength;
    submitKey.classList.toggle('is-loading', busy);
  }

  function clearError() {
    clearTimeout(errorTimer);
    el.classList.remove('is-error', 'is-shaking');
    if (!locked) message.textContent = hint;
  }

  function press(digit) {
    if (busy || locked || digits.length >= maxLength) return;
    if (el.classList.contains('is-error')) clearError();
    digits += digit;
    render();
    if (autoSubmit && digits.length === maxLength) void submit();
  }

  function backspace() {
    if (busy || locked || !digits) return;
    digits = digits.slice(0, -1);
    clearError();
    render();
  }

  async function submit() {
    if (busy || locked || digits.length < minLength) return;
    busy = true;
    render();
    const pin = digits;
    try {
      await onSubmit(pin);
    } catch (err) {
      if (destroyed) return;
      busy = false;
      const retryAfter = Number(err?.data?.retryAfter);
      if (err?.status === 429 && retryAfter > 0) lock(retryAfter);
      else showError(errorMessage(err));
      return;
    } finally {
      if (!destroyed && busy) {
        busy = false;
        render();
      }
    }
  }

  function errorMessage(err) {
    const base = err?.message || 'PIN incorrecto.';
    const left = Number(err?.data?.attemptsLeft);
    if (Number.isFinite(left) && left > 0 && left <= 3) {
      return `${base} Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.`;
    }
    return base;
  }

  /** Shows an error: shake, vibration, message; clears the digits. */
  function showError(text) {
    digits = '';
    render();
    message.textContent = text;
    el.classList.remove('is-shaking');
    void el.offsetWidth; // restart the animation
    el.classList.add('is-error', 'is-shaking');
    vibrate([80, 60, 80]);
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => el.classList.remove('is-shaking'), 450);
  }

  /** Disables the pad for `seconds` with a countdown message. */
  function lock(seconds) {
    locked = true;
    digits = '';
    clearInterval(lockTimer);
    // Counted against the clock: timers are throttled while the screen is off.
    const deadline = Date.now() + Math.ceil(seconds) * 1000;
    el.classList.add('is-error');
    vibrate([80, 60, 80]);
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (left <= 0) {
        clearInterval(lockTimer);
        locked = false;
        el.classList.remove('is-error');
        message.textContent = hint;
        render();
        return;
      }
      // Locks grow up to 15 minutes: "4 min 30 s" rather than "270 s".
      message.textContent = `Demasiados intentos. Vuelve a intentarlo en ${fmt.wait(left)}.`;
    };
    tick();
    lockTimer = setInterval(tick, 1000);
    render();
  }

  function onKeydown(event) {
    if (destroyed || !el.isConnected || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (el.closest('[inert]')) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      press(event.key);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      backspace();
    } else if (event.key === 'Enter' && !(target instanceof HTMLButtonElement)) {
      event.preventDefault();
      void submit();
    }
  }
  document.addEventListener('keydown', onKeydown);

  render();

  return {
    el,
    /** Clears the digits and any error. */
    clear() {
      digits = '';
      clearError();
      render();
    },
    showError,
    lock,
    /** Moves focus into the pad (first key) for keyboard users. */
    focus() {
      keys.querySelector('button:not(:disabled)')?.focus();
    },
    /** Removes the global keyboard listener and timers. */
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKeydown);
      clearInterval(lockTimer);
      clearTimeout(errorTimer);
    },
  };
}
