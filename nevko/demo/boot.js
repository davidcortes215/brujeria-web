// Entry point of the demonstration page (demo/index.html): installs the in-browser
// backend (mock-api.js, which first loads the data: shared between the user's devices when
// the viewer serves `db`, otherwise from this device), shows the demo ribbon and starts the
// application.

import { confirmResetDemo } from '../js/demo.js';
import { h } from '../js/dom.js';
import { icon } from '../js/icons.js';
import { installDemo } from './mock-api.js';

/** [long, short] text after «Demostración» (the short one on narrow screens). */
const RIBBON_TEXTS = {
  shared: [' · datos compartidos entre tus dispositivos', ' · datos compartidos'],
  local: [' · datos de ejemplo guardados solo en este dispositivo', ' · datos solo en este dispositivo'],
};

function ribbon() {
  const long = h('span.demo-ribbon-long');
  const short = h('span.demo-ribbon-short');
  const setMode = (mode) => {
    const [longText, shortText] = RIBBON_TEXTS[mode] ?? RIBBON_TEXTS.local;
    long.textContent = longText;
    short.textContent = shortText;
  };
  const demo = window.TRACKTOOL_DEMO;
  setMode(demo?.shared ? 'shared' : 'local');
  demo?.onModeChange?.(setMode);
  return h(
    'div.demo-ribbon',
    { role: 'note', 'aria-label': 'Demostración' },
    h('span.demo-ribbon-text', icon('info', { size: 16 }), h('strong', 'Demostración'), long, short),
    h(
      'button.demo-ribbon-btn',
      {
        type: 'button',
        title: 'Volver a los datos de ejemplo',
        'aria-label': 'Restablecer la demostración',
        onClick: () => void confirmResetDemo(),
      },
      icon('refresh', { size: 14 }),
      h('span.demo-ribbon-btn-label', 'Restablecer'),
    ),
  );
}

function bootError() {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.remove('boot');
  app.removeAttribute('aria-busy');
  app.replaceChildren(
    h(
      'div.noscript',
      h('h1', 'No se ha podido abrir la demostración'),
      h('p', 'Recarga la página. Si el problema continúa, prueba con otro navegador.'),
    ),
  );
}

async function start() {
  document.documentElement.lang = 'es';
  await installDemo();
  document.body.insertBefore(ribbon(), document.getElementById('app'));
  document.body.classList.add('is-demo');
  await import('../js/main.js');
}

start().catch((err) => {
  console.error(err);
  bootError();
});
