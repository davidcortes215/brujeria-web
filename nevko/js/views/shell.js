// App shells.
//   createShell()       operator app: top bar (brand + operator chip menu, which also holds the
//                       per-device "Dispositivo compartido" option), main area and the bottom
//                       tab bar (Buscar | En lista with the pick list badge | Guardar with the
//                       in-use badge).
//   createPlainShell()  sign-in screen: top bar (brand + theme toggle) and main area.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, brand, iconButton } from '../components.js';
import { canResetDemo, confirmResetDemo } from '../demo.js';
import * as fmt from '../fmt.js';
import { SHARED_IDLE_MS, isSharedDevice, setSharedDevice } from '../session.js';
import { store } from '../store.js';
import { menu, toast } from '../ui.js';
import { THEME_OPTIONS, effectiveTheme, getTheme, onThemeChange, setTheme, toggleTheme } from '../theme.js';

/**
 * @param {object} handlers
 * @param {()=>void} handlers.onSwitchOperator
 * @param {()=>void} handlers.onSignOut
 * @param {(name:'buscar'|'lista'|'guardar', event:MouseEvent)=>void} handlers.onTab
 * @returns {{ el: HTMLElement, main: HTMLElement, setActive(name): void, destroy(): void }}
 */
export function createShell({ onSwitchOperator, onSignOut, onTab }) {
  const chipAvatar = h('span');
  const chipName = h('span.chip-label');
  const chip = h(
    'button.chip',
    { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: openOperatorMenu },
    chipAvatar,
    chipName,
    icon('chevron-down', { size: 16 }),
  );

  const topbar = h(
    'header.topbar',
    h('div.topbar-inner', brand({ href: '#/buscar' }), h('div.topbar-actions', chip)),
  );

  const main = h('main.main#main', { tabIndex: -1 });

  const pickBadge = h('span.tab-badge', { hidden: true, 'aria-hidden': 'true' });
  const badge = h('span.tab-badge', { hidden: true, 'aria-hidden': 'true' });
  const tabs = {
    buscar: tab('buscar', 'Buscar', 'search'),
    lista: tab('lista', 'En lista', 'clipboard-list', pickBadge),
    guardar: tab('guardar', 'Guardar', 'archive', badge),
  };
  const tabbar = h(
    'nav.tabbar',
    { 'aria-label': 'Secciones' },
    h('div.tabbar-inner', { style: { '--tabs': 3 } }, tabs.buscar, tabs.lista, tabs.guardar),
  );

  const el = h('div.app', topbar, main, tabbar);

  function tab(name, label, iconName, extra = null) {
    return h(
      'a.tab',
      { href: `#/${name}`, dataset: { tab: name }, onClick: (event) => onTab(name, event) },
      h('span.tab-icon', icon(iconName, { size: 24 }), extra),
      h('span.tab-label', label),
    );
  }

  const unsubscribers = [
    store.select(
      (state) => state.operator?.name ?? '',
      (name) => {
        chipName.textContent = name || 'Operario';
        chipAvatar.replaceChildren(avatar(name || '?', { size: 'sm' }));
        chip.setAttribute('aria-label', name ? `Operario: ${name}. Abrir menú` : 'Abrir menú');
      },
    ),
    store.select(
      (state) => state.inUseCount,
      (count) => {
        badge.hidden = count === 0;
        badge.textContent = count > 99 ? '99+' : String(count);
        tabs.guardar.setAttribute('aria-label', count ? `Guardar, ${fmt.tools(count)} en uso` : 'Guardar');
      },
    ),
    store.select(
      (state) => state.pickCount,
      (count) => {
        pickBadge.hidden = count === 0;
        pickBadge.textContent = count > 99 ? '99+' : String(count);
        tabs.lista.setAttribute('aria-label', count ? `En lista, ${fmt.tools(count)}` : 'En lista');
      },
    ),
  ];

  function openOperatorMenu() {
    const { operator, inUseCount, pickCount } = store.get();
    const name = operator?.name ?? 'Operario';
    const mode = getTheme();
    menu(chip, {
      label: 'Menú del operario',
      header: [
        avatar(name),
        h(
          'div.menu-header-text',
          h('div.menu-header-title', name),
          h(
            'div.menu-header-sub',
            inUseCount ? `${fmt.tools(inUseCount)} en uso` : 'Sin útiles en uso',
            pickCount ? ` · ${pickCount} en lista` : null,
          ),
        ),
      ],
      items: [
        { label: 'Cambiar operario', icon: 'users', onSelect: onSwitchOperator },
        { label: 'Dispositivo compartido', icon: 'smartphone', checkbox: true, checked: isSharedDevice(), onSelect: toggleShared },
        { separator: true },
        { heading: 'Tema' },
        ...THEME_OPTIONS.map((option) => ({
          label: option.label,
          icon: option.icon,
          checked: mode === option.value,
          onSelect: () => setTheme(option.value),
        })),
        ...(canResetDemo()
          ? [{ separator: true }, { label: 'Restablecer demostración', icon: 'refresh', onSelect: () => void confirmResetDemo() }]
          : []),
        { separator: true },
        { label: 'Salir', icon: 'log-out', danger: true, onSelect: onSignOut },
      ],
    });
  }

  /** Per-device option: sign out after a few minutes without interaction (see session.watchIdle). */
  function toggleShared() {
    const on = !isSharedDevice();
    setSharedDevice(on);
    toast(
      on
        ? `Dispositivo compartido: la sesión se cerrará tras ${SHARED_IDLE_MS / 60_000} minutos sin actividad.`
        : 'Dispositivo compartido desactivado: la sesión se mantiene abierta.',
      { type: on ? 'success' : 'info' },
    );
  }

  document.body.classList.add('has-tabbar');

  return {
    el,
    main,
    /** Highlights a tab ('buscar' | 'lista' | 'guardar'). */
    setActive(name) {
      for (const [key, link] of Object.entries(tabs)) {
        if (key === name) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
    destroy() {
      unsubscribers.forEach((fn) => fn());
      document.body.classList.remove('has-tabbar', 'has-actionbar');
    },
  };
}

/**
 * Minimal shell for the sign-in screen: brand and a light/dark toggle, no tab bar.
 * @returns {{ el: HTMLElement, main: HTMLElement, destroy(): void }}
 */
export function createPlainShell() {
  const toggle = iconButton({ icon: 'moon', label: 'Tema oscuro', onClick: () => toggleTheme() });
  const syncToggle = () => {
    const dark = effectiveTheme() === 'dark';
    const label = dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
    toggle.replaceChildren(icon(dark ? 'sun' : 'moon'));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  };
  syncToggle();
  const stopTheme = onThemeChange(syncToggle);

  const topbar = h(
    'header.topbar',
    h('div.topbar-inner', brand({ href: null }), h('div.topbar-actions', toggle)),
  );
  const main = h('main.main#main', { tabIndex: -1 });
  const el = h('div.app', topbar, main);

  return {
    el,
    main,
    destroy() {
      stopTheme();
    },
  };
}
