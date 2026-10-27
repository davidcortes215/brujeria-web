// #/admin/ajustes — connect devices (LAN URLs with copy buttons, the server-generated
// QR code and step-by-step Android instructions), change the admin PIN, CSV export and
// database backup, appearance and version.

import { alertBox, button, card, field, iconButton, segmented, spinner, tag } from '../components.js';
import {
  canEmptyDemo,
  canResetDemo,
  confirmEmptyDemo,
  confirmResetDemo,
  confirmUploadDeviceCopy,
  demoDeviceCopy,
  isDemo,
  isSharedDemo,
} from '../demo.js';
import { h, replace, svgFromString } from '../dom.js';
import { icon } from '../icons.js';
import { THEME_OPTIONS, getTheme, onThemeChange, setTheme } from '../theme.js';
import * as ui from '../ui.js';
import {
  adminRequest,
  copyText,
  downloadAdminFile,
  formatWait,
  inlineError,
  isLocalHost,
  pageHeader,
  pinInput,
  reportError,
} from './common.js';

const ADMIN_PIN_RE = /^\d{4,8}$/;

export function mountSettings(root) {
  let destroyed = false;
  let controller = null;
  let stopTheme = null;

  const header = pageHeader({
    title: 'Ajustes',
    subtitle: 'Conexión de los móviles, seguridad y copias de seguridad.',
  });

  const connectBody = h('div', h('div.loading-block', spinner(), h('span', 'Buscando la dirección del servidor…')));
  const versionValue = h('dd.tabular', '—');

  const connectCard = card({
    title: 'Conectar dispositivos',
    subtitle: 'Abre Nevko en los móviles del taller y añádela a su pantalla de inicio.',
    body: connectBody,
    className: 'adm-connect-card',
  });

  root.append(
    header.el,
    connectCard,
    h(
      'div.adm-settings-grid',
      pinCard(),
      dataCard(),
      appearanceCard(),
      canResetDemo() ? demoCard() : null,
      card({
        title: 'Acerca de',
        body: h(
          'dl.dl',
          h('dt', 'Aplicación'),
          h('dd', 'Nevko — Utillaje', h('span.subtle', ' · by BrujerIA')),
          h('dt', 'Versión'),
          versionValue,
          h('dt', 'Esta página'),
          h('dd.mono.break', window.location.origin),
        ),
      }),
    ),
  );

  void loadServerInfo();

  // Conectar dispositivos -----------------------------------------------------------

  async function loadServerInfo() {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const info = await adminRequest('GET', '/admin/server-info', { signal: mine.signal });
      if (destroyed || controller !== mine) return;
      versionValue.textContent = info?.version || '—';
      replace(connectBody, connectContent(info ?? {}));
    } catch (err) {
      if (destroyed || controller !== mine || err.code === 'ABORTED' || err.status === 401) return;
      replace(connectBody, inlineError(err, () => {
        replace(connectBody, h('div.loading-block', spinner()));
        void loadServerInfo();
      }));
    }
  }

  function connectContent(info) {
    const urls = Array.isArray(info.urls) ? info.urls.filter((u) => typeof u === 'string' && u) : [];
    const demo = isDemo();
    const current = window.location.origin;
    const fallback = urls.length === 0 && !demo && !isLocalHost(window.location.hostname) ? [current] : [];
    const shown = urls.length ? urls : fallback;

    const qr = info.qrSvg && urls.length ? svgFromString(info.qrSvg) : null;
    if (qr) {
      qr.setAttribute('role', 'img');
      qr.setAttribute('aria-label', `Código QR con la dirección ${urls[0]}`);
    }

    const addresses = shown.length
      ? h(
          'div.adm-urls',
          h('div.adm-urls-label', shown.length > 1 ? 'Direcciones de este servidor' : 'Dirección de este servidor'),
          shown.map((url, index) => urlRow(url, index === 0 && shown.length > 1)),
          shown.length > 1 ? h('p.small.subtle', 'Si el móvil no carga la primera, prueba con las demás.') : null,
        )
      : null;

    const noNetwork = demo
      ? alertBox({
          title: 'En la demo no hay servidor',
          text:
            'Los móviles se conectarán cuando Nevko esté instalada en el ordenador del taller. Entonces aparecerán aquí sus direcciones de red y un código QR para abrirla desde cada móvil.',
        })
      : urls.length === 0
        ? alertBox({
            type: 'warning',
            title: 'No se ha encontrado ninguna red local',
            text:
              'Ahora mismo solo se puede abrir Nevko desde este ordenador. Conéctalo a la red del taller (wifi o cable) y vuelve a abrir esta página. Si arrancaste el servidor con HOST=127.0.0.1, arráncalo sin esa variable.',
          })
        : null;

    const steps = h(
      'ol.adm-steps',
      step('Conecta el móvil a la misma red wifi que este ordenador.'),
      step(qr ? 'Escanea el código QR con la cámara del móvil, o escribe la dirección en Chrome.' : 'Abre Chrome en el móvil y escribe la dirección.'),
      step(
        h(
          'span',
          'En Chrome, abre el menú ',
          h('kbd.adm-kbd', { 'aria-label': 'de tres puntos' }, '⋮'),
          ' y pulsa ',
          h('strong', '«Añadir a pantalla de inicio»'),
          '. Se crea un icono de acceso directo a Nevko.',
        ),
      ),
      step('Abre Nevko desde ese icono y elige tu nombre. El móvil recordará al operario.'),
    );

    return h(
      'div.adm-connect',
      qr
        ? h('figure.adm-qr', h('div.qr', qr), h('figcaption', 'Escanéalo con la cámara del móvil'))
        : null,
      h(
        'div.adm-connect-main',
        noNetwork,
        addresses,
        h('div.adm-steps-title', 'Cómo añadirla a un móvil Android'),
        steps,
        h(
          'p.adm-note.small.subtle',
          icon('info', { size: 14 }),
          'Si el móvil no llega a cargar la página, permite a Node.js el acceso a redes privadas en el Firewall de Windows.',
        ),
      ),
    );
  }

  function step(content) {
    return h('li.adm-step', h('span.adm-step-text', content));
  }

  function urlRow(url, primary) {
    const copyButton = iconButton({
      icon: 'copy',
      label: `Copiar ${url}`,
      size: 'sm',
      onClick: async () => {
        const ok = await copyText(url);
        if (ok) {
          replace(copyButton, icon('check', { size: 16 }));
          copyButton.classList.add('is-copied');
          setTimeout(() => {
            replace(copyButton, icon('copy', { size: 16 }));
            copyButton.classList.remove('is-copied');
          }, 1600);
          ui.toast('Dirección copiada.', { type: 'success', duration: 2000 });
        } else {
          ui.toast('No se ha podido copiar. Selecciona la dirección y cópiala a mano.', { type: 'warning' });
        }
      },
    });
    return h('div.url-row', h('span', url), primary ? tag('Principal', 'primary') : null, copyButton);
  }

  // PIN de administración -------------------------------------------------------------

  function pinCard() {
    const currentEl = pinInput({ maxLength: 8, secret: true, autocomplete: 'current-password' });
    const nextEl = pinInput({ maxLength: 8, secret: true, autocomplete: 'new-password' });
    const repeatEl = pinInput({ maxLength: 8, secret: true, autocomplete: 'new-password' });
    const currentField = field({ label: 'PIN actual', control: currentEl });
    const nextField = field({ label: 'Nuevo PIN', control: nextEl, hint: 'Entre 4 y 8 dígitos.' });
    const repeatField = field({ label: 'Repite el nuevo PIN', control: repeatEl });
    const submit = button({ label: 'Cambiar PIN', icon: 'key', variant: 'primary', type: 'submit' });

    const form = h(
      'form.form',
      { noValidate: true, onSubmit: (event) => {
        event.preventDefault();
        void change();
      } },
      // Lets password managers associate the fields with an account (Chrome recommends it).
      h('input', { type: 'text', name: 'username', defaultValue: 'administracion', autocomplete: 'username', hidden: true, tabIndex: -1, 'aria-hidden': 'true' }),
      currentField,
      h('div.form-row', nextField, repeatField),
      h('div', submit),
    );

    async function change() {
      [currentField, nextField, repeatField].forEach((f) => f.setError(null));
      const currentPin = currentEl.value;
      const newPin = nextEl.value;
      if (!currentPin) {
        currentField.setError('Introduce el PIN actual.');
        currentEl.focus();
        return;
      }
      if (!ADMIN_PIN_RE.test(newPin)) {
        nextField.setError('El nuevo PIN debe tener entre 4 y 8 dígitos.');
        nextEl.focus();
        return;
      }
      if (newPin !== repeatEl.value) {
        repeatField.setError('Los PIN no coinciden.');
        repeatEl.focus();
        return;
      }
      if (newPin === currentPin) {
        nextField.setError('El nuevo PIN es igual al actual.');
        nextEl.focus();
        return;
      }
      await ui.withBusy(submit, async () => {
        try {
          await adminRequest('POST', '/admin/pin', { body: { currentPin, newPin } });
          form.reset();
          ui.toast('PIN de administración cambiado. Se han cerrado las demás sesiones de administración.', { type: 'success', duration: 5000 });
        } catch (err) {
          if (err.status === 401 || err.code === 'ABORTED') return;
          if (err.code === 'PIN_INVALID' || err.code === 'PIN_REQUIRED') {
            const left = Number(err.data?.attemptsLeft);
            const suffix = Number.isFinite(left) && left > 0 && left <= 3 ? ` Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.` : '';
            currentField.setError(`${err.message}${suffix}`);
            currentEl.value = '';
            currentEl.focus();
            return;
          }
          if (err.status === 429) {
            const seconds = Number(err.data?.retryAfter);
            currentField.setError(seconds > 0 ? `Demasiados intentos fallidos. Espera ${formatWait(seconds)} y vuelve a probar.` : err.message);
            return;
          }
          if (err.code === 'PIN_FORMAT') {
            nextField.setError(err.message);
            nextEl.focus();
            return;
          }
          reportError(err, 'No se ha podido cambiar el PIN.');
        }
      });
    }

    return card({
      title: 'PIN de administración',
      subtitle: 'Al cambiarlo se cierran las demás sesiones de administración.',
      body: form,
    });
  }

  // Datos -----------------------------------------------------------------------------

  function dataCard() {
    const row = (iconName, title, text, action) =>
      h(
        'div.adm-data-row',
        h('span.adm-data-icon', icon(iconName, { size: 20 })),
        h('div.grow', h('div.adm-data-title', title), h('div.adm-data-text', text)),
        action,
      );
    const exportButton = button({ label: 'Exportar CSV', icon: 'download', size: 'sm' });
    const backupButton = button({ label: 'Descargar copia', icon: 'database', size: 'sm' });
    const includeInactive = h('input', { type: 'checkbox' });
    exportButton.addEventListener('click', () =>
      void download(
        exportButton,
        includeInactive.checked ? '/admin/export.csv?includeInactive=1' : '/admin/export.csv',
        'nevko-utiles.csv',
        'No se ha podido exportar el catálogo.',
      ),
    );
    backupButton.addEventListener('click', () => void download(backupButton, '/admin/backup', 'nevko.db', 'No se ha podido descargar la copia de seguridad.'));
    return card({
      title: 'Datos',
      subtitle: 'Exporta el catálogo o guarda una copia completa.',
      padded: false,
      body: h(
        'div.adm-data',
        row(
          'file-text',
          'Catálogo en CSV',
          [
            h('span.adm-data-line', 'Los útiles activos con su ubicación, estado y operario actual. Se abre con Excel y se puede corregir e importar de nuevo.'),
            h('label.check.adm-export-check', includeInactive, h('span', 'Incluir también los dados de baja')),
          ],
          exportButton,
        ),
        row(
          'database',
          'Copia de seguridad',
          'Base de datos completa: útiles, operarios e historial. Guárdala fuera de este ordenador.',
          backupButton,
        ),
      ),
    });
  }

  async function download(buttonEl, path, fallbackName, failure) {
    await ui.withBusy(buttonEl, async () => {
      try {
        const name = await downloadAdminFile(path, fallbackName);
        ui.toast(`Descargado ${name}`, { type: 'success' });
      } catch (err) {
        reportError(err, failure);
      }
    });
  }

  // Demostración (demo build only) -------------------------------------------------------

  function demoCard() {
    const shared = isSharedDemo();
    const deviceCopy = shared ? demoDeviceCopy() : null;
    return card({
      title: 'Demostración',
      subtitle: shared
        ? 'Los datos se comparten entre tus dispositivos: lo que cambies en uno se ve en los demás al momento.'
        : 'Los datos de ejemplo y tus cambios se guardan solo en este dispositivo.',
      body: h(
        'div.stack.stack-sm',
        shared
          ? h('p.small.muted', 'Abre esta misma página en el móvil para usarla como operario mientras administras desde el ordenador.')
          : null,
        h(
          'p.small.muted',
          shared
            ? 'Restablecer vuelve a cargar el catálogo, los operarios y los préstamos de ejemplo en todos tus dispositivos.'
            : 'Restablecer vuelve a cargar el catálogo, los operarios y los préstamos de ejemplo.',
        ),
        h('div', button({ label: 'Restablecer demostración', icon: 'refresh', size: 'sm', onClick: () => void confirmResetDemo() })),
        canEmptyDemo()
          ? [
              h(
                'p.small.muted',
                shared
                  ? 'Para probar con tu propio listado: vacía el catálogo de ejemplo y luego impórtalo en Importar. El archivo se lee en este dispositivo y el catálogo importado se guarda en los datos compartidos de la demostración.'
                  : 'Para probar con tu propio listado: vacía el catálogo de ejemplo y luego impórtalo en Importar. El archivo se lee en este dispositivo y no se envía a ningún servidor.',
              ),
              h('div', button({ label: 'Empezar sin útiles', icon: 'trash', size: 'sm', onClick: () => void confirmEmptyDemo() })),
            ]
          : null,
        deviceCopy
          ? [
              h(
                'p.small.muted',
                `Este dispositivo conserva los datos que tenía antes de compartirlos (${deviceCopy}). Si son los buenos, súbelos para usarlos en todos tus dispositivos.`,
              ),
              h(
                'div',
                button({ label: 'Subir los datos de este dispositivo', icon: 'upload', size: 'sm', onClick: () => void confirmUploadDeviceCopy() }),
              ),
            ]
          : null,
      ),
    });
  }

  // Apariencia ---------------------------------------------------------------------------

  function appearanceCard() {
    const control = segmented({
      label: 'Tema',
      options: THEME_OPTIONS.map((option) => ({ value: option.value, label: option.label, icon: option.icon })),
      value: getTheme(),
      onChange: (value) => setTheme(value),
    });
    stopTheme = onThemeChange(({ mode }) => {
      control.value = mode;
    });
    return card({
      title: 'Apariencia',
      subtitle: 'Se guarda en este dispositivo. «Automático» sigue el tema del sistema.',
      body: control,
    });
  }

  return {
    destroy() {
      destroyed = true;
      controller?.abort();
      stopTheme?.();
    },
  };
}

