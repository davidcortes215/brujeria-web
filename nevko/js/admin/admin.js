// Administration area (#/admin, #/admin/*), loaded on demand by main.js.
//
// Contract with main.js (public/js/README.md):
//   export async function mountAdmin(container, ctx) -> {
//     update(route, { direction }),   // another #/admin/... route while mounted
//     onUnauthorized(error),          // an admin request got 401 (token already removed)
//     destroy(),                      // leaving the administration area
//   }
//
// Routes
//   #/admin                    login, or first-run setup when no admin PIN exists yet
//                              (?next=/admin/utiles returns there after signing in)
//   #/admin/panel | importar | utiles | operarios | historial | ajustes
//
// The admin token lives in localStorage 'tt.adminToken' (api.tokens, admin = true).
// Pages are small modules: mountX(root, env) -> { destroy(), onChange?(event) }.
// Styles: css/admin.css (appended once to <head>, on top of css/app.css).

import { api, request, tokens } from '../api.js';
import { button, iconButton, loadingBlock, brand, errorState } from '../components.js';
import { clear, h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { router } from '../router.js';
import { THEME_OPTIONS, effectiveTheme, getTheme, onThemeChange, setTheme, toggleTheme } from '../theme.js';
import * as ui from '../ui.js';
import { mountAuth } from './auth.js';
import { mountHistory } from './history.js';
import { mountImport } from './import.js';
import { mountOperators } from './operators.js';
import { mountPanel } from './panel.js';
import { mountSettings } from './settings.js';
import { mountTools } from './tools.js';

// Relative to this module, so it also loads when the page is not at the site root (demo).
const STYLESHEET = new URL('../../css/admin.css', import.meta.url).href;
const STYLESHEET_TIMEOUT_MS = 2500;

const PAGES = [
  { id: 'panel', label: 'Panel', icon: 'dashboard', mount: mountPanel },
  { id: 'importar', label: 'Importar', icon: 'upload', mount: mountImport },
  { id: 'utiles', label: 'Útiles', icon: 'tool', mount: mountTools },
  { id: 'operarios', label: 'Operarios', icon: 'users', mount: mountOperators },
  { id: 'historial', label: 'Historial', icon: 'history', mount: mountHistory },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings', mount: mountSettings },
];
const PAGE_BY_ID = new Map(PAGES.map((page) => [page.id, page]));
const HOME = '/admin/panel';

/** '/admin/utiles' -> 'utiles'; '/admin' -> null; unknown pages -> '' */
function pageIdOf(path) {
  if (path === '/admin') return null;
  const match = /^\/admin\/([^/]+)$/.exec(path);
  return match && PAGE_BY_ID.has(match[1]) ? match[1] : '';
}

/** Only known admin pages are accepted as "?next=" targets. */
function safeNext(next) {
  return typeof next === 'string' && pageIdOf(next) ? next : null;
}

function routeKey(route) {
  const query = new URLSearchParams(route.query ?? {}).toString();
  return `${route.path}?${query}`;
}

/** Appends css/admin.css once; resolves when it is applied (or after a short timeout). */
function loadStylesheet() {
  let link = document.querySelector('link[data-admin-css]');
  if (!link) {
    link = h('link', { rel: 'stylesheet', href: STYLESHEET, 'data-admin-css': '' });
    document.head.append(link);
  }
  if (link.sheet) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, STYLESHEET_TIMEOUT_MS);
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
  });
}

/**
 * Checks a stored admin token without triggering the global 401 handling (explicit token).
 * Network problems count as valid: the pages show their own errors and the offline banner.
 */
async function sessionIsValid(token) {
  try {
    await request('GET', '/admin/tools', { token, query: { status: 'all', limit: 1 }, timeout: 8000 });
    return true;
  } catch (err) {
    if (err.status === 401) {
      tokens.clear(true);
      return false;
    }
    return true;
  }
}

export async function mountAdmin(container, ctx) {
  let destroyed = false;
  let authed = false;
  let renderedKey = null;
  let authSeq = 0;
  let shell = null; // { el, nav, main, items, topbar }
  let authFrame = null; // { el, topbar, view }
  let page = null; // { id, instance }
  const pageStore = new Map(); // per-page state kept while the admin area is open

  replace(container, loadingBlock('Cargando administración…'));
  await loadStylesheet();

  const token = tokens.get(true);
  if (token) authed = await sessionIsValid(token);

  const unsubscribe = api.subscribe((event) => {
    if (!authed || !page?.instance?.onChange) return;
    try {
      page.instance.onChange(event);
    } catch (err) {
      console.error(err);
    }
  });

  show(router.current());

  // ---------------------------------------------------------------------------
  // Routing

  function show(route, { force = false } = {}) {
    if (destroyed || !route) return;
    const key = routeKey(route);
    if (!force && key === renderedKey) return;
    const pageId = pageIdOf(route.path);

    if (!authed) {
      if (route.path !== '/admin') {
        redirect('/admin', pageId ? { next: route.path } : undefined);
        return;
      }
      renderedKey = key;
      void showAuth(route);
      return;
    }
    if (!pageId) {
      redirect(safeNext(route.query?.next) ?? HOME);
      return;
    }
    renderedKey = key;
    showPage(PAGE_BY_ID.get(pageId), route);
  }

  /** Replaces the URL and renders the target now (main does not call update() while mounting). */
  function redirect(path, query) {
    router.navigate(path, { replace: true, query });
    const target = router.parseHash(router.href(path, query));
    show({ name: 'admin', path: target.path, params: {}, query: target.query });
  }

  /** Opens another section; `intent` (e.g. { create: true }) is read by that page when it mounts. */
  function go(pageId, intent) {
    if (intent) storeFor(pageId).intent = intent;
    const path = `/admin/${pageId}`;
    if (router.parseHash().path === path) show(router.current(), { force: true });
    else router.navigate(path);
  }

  function storeFor(pageId) {
    if (!pageStore.has(pageId)) pageStore.set(pageId, {});
    return pageStore.get(pageId);
  }

  // ---------------------------------------------------------------------------
  // Sign-in screen

  async function showAuth(route) {
    teardownShell();
    teardownAuth();
    const seq = ++authSeq;
    const frame = createAuthFrame();
    authFrame = frame;
    replace(container, frame.el);
    replace(frame.body, loadingBlock('Comprobando…'));
    document.title = 'Administración · Nevko';
    window.scrollTo({ top: 0, left: 0 });

    let configured;
    try {
      ({ configured } = await request('GET', '/admin/state', { auth: false }));
    } catch (err) {
      if (seq !== authSeq || destroyed) return;
      replace(
        frame.body,
        errorState(err, () => void showAuth(route), { title: 'No se ha podido conectar con el servidor' }),
      );
      return;
    }
    if (seq !== authSeq || destroyed || authed) return;
    clear(frame.body);
    frame.view = mountAuth(frame.body, {
      configured: Boolean(configured),
      onToken: (newToken) => {
        tokens.set(newToken, true);
        authed = true;
        redirect(safeNext(route.query?.next) ?? HOME);
      },
    });
    frame.view.focus?.();
  }

  function createAuthFrame() {
    const topbar = createTopbar({ signedIn: false });
    const body = h('main.adm-auth-main#main', { tabIndex: -1 });
    const el = h('div.admin.adm-signin', topbar.el, body);
    return { el, body, topbar, view: null };
  }

  function teardownAuth() {
    if (!authFrame) return;
    authFrame.view?.destroy();
    authFrame.topbar.destroy();
    authFrame = null;
  }

  // ---------------------------------------------------------------------------
  // Signed-in shell: top bar, section navigation, page area

  function ensureShell() {
    if (shell) return shell;
    teardownAuth();
    const topbar = createTopbar({ signedIn: true });
    const items = new Map();
    const nav = h(
      'nav.admin-nav',
      { 'aria-label': 'Secciones de administración' },
      PAGES.map((def) => {
        const item = h(
          'a.admin-nav-item',
          { href: `#/admin/${def.id}`, dataset: { page: def.id } },
          icon(def.icon, { size: 18 }),
          h('span', def.label),
        );
        items.set(def.id, item);
        return item;
      }),
    );
    const main = h('main.admin-main#main', { tabIndex: -1 });
    const el = h('div.admin', topbar.el, h('div.admin-body', nav, main));
    replace(container, el);
    shell = { el, nav, main, items, topbar };
    return shell;
  }

  function teardownShell() {
    destroyPage();
    if (!shell) return;
    shell.topbar.destroy();
    shell = null;
  }

  function destroyPage() {
    if (!page) return;
    try {
      page.instance?.destroy?.();
    } catch (err) {
      console.error(err);
    }
    page = null;
  }

  function showPage(def, route) {
    const { main, nav, items } = ensureShell();
    const samePage = page?.id === def.id;
    destroyPage();

    for (const [id, item] of items) {
      if (id === def.id) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    revealNavItem(nav, items.get(def.id));

    const root = h('div.adm-page.view', { dataset: { page: def.id } });
    replace(main, root);
    document.title = `${def.label} · Administración · Nevko`;
    if (!samePage) window.scrollTo({ top: 0, left: 0 });

    const env = {
      route,
      store: storeFor(def.id),
      go,
      navigate: router.navigate,
    };
    let instance = null;
    try {
      instance = def.mount(root, env) ?? {};
    } catch (err) {
      console.error(err);
      replace(root, errorState({ message: 'Esta sección no se ha podido mostrar. Recarga la página.' }, () => window.location.reload()));
      instance = {};
    }
    page = { id: def.id, instance };
    root.querySelector('.admin-page-title')?.focus({ preventScroll: true });
  }

  /** Keeps the active section visible in the horizontal tab strip (phones). */
  function revealNavItem(nav, item) {
    if (!item || nav.scrollWidth <= nav.clientWidth) return;
    const left = item.offsetLeft - (nav.clientWidth - item.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: ui.prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  // ---------------------------------------------------------------------------
  // Top bar (brand, back to the operator app, theme, logout)

  function createTopbar({ signedIn }) {
    const themeButton = iconButton({ icon: 'moon', label: 'Tema oscuro', className: 'adm-top-theme', onClick: () => toggleTheme() });
    const syncTheme = () => {
      const dark = effectiveTheme() === 'dark';
      const label = dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
      replace(themeButton, icon(dark ? 'sun' : 'moon'));
      themeButton.setAttribute('aria-label', label);
      themeButton.title = label;
    };
    syncTheme();
    const stopTheme = onThemeChange(syncTheme);

    const appButton = button({
      icon: 'smartphone',
      label: 'App de operarios',
      ariaLabel: 'Ir a la app de operarios',
      title: 'Ir a la app de operarios',
      variant: 'ghost',
      size: 'sm',
      className: 'adm-top-btn',
      onClick: () => ctx.exit(),
    });
    const logoutButton = signedIn
      ? button({
          icon: 'log-out',
          label: 'Salir',
          ariaLabel: 'Cerrar la sesión de administración',
          title: 'Cerrar la sesión de administración',
          variant: 'secondary',
          size: 'sm',
          className: 'adm-top-btn',
          onClick: () => logout(),
        })
      : null;
    const menuButton = iconButton({
      icon: 'more-vertical',
      label: 'Menú de administración',
      className: 'adm-top-menu',
      attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      onClick: () => openMenu(),
    });

    function openMenu() {
      const mode = getTheme();
      ui.menu(menuButton, {
        label: 'Menú de administración',
        items: [
          { label: 'App de operarios', icon: 'smartphone', onSelect: () => ctx.exit() },
          { separator: true },
          { heading: 'Tema' },
          ...THEME_OPTIONS.map((option) => ({
            label: option.label,
            icon: option.icon,
            checked: mode === option.value,
            onSelect: () => setTheme(option.value),
          })),
          ...(signedIn ? [{ separator: true }, { label: 'Cerrar sesión', icon: 'log-out', danger: true, onSelect: () => logout() }] : []),
        ],
      });
    }

    const el = h(
      'header.topbar.adm-topbar',
      h(
        'div.topbar-inner.is-wide',
        brand({ subtitle: 'Administración', href: signedIn ? `#${HOME}` : '#/admin' }),
        h('div.topbar-actions', appButton, themeButton, logoutButton, menuButton),
      ),
    );
    return { el, destroy: stopTheme };
  }

  function logout() {
    const current = tokens.get(true);
    tokens.clear(true);
    authed = false;
    // Explicit token: a 401 here (session already gone) must not trigger onUnauthorized.
    if (current) void request('POST', '/admin/logout', { token: current, timeout: 8000 }).catch(() => {});
    ui.closeAll();
    redirect('/admin');
    ui.toast('Has cerrado la sesión de administración.', { type: 'success' });
  }

  // ---------------------------------------------------------------------------
  // Instance

  return {
    update(route) {
      show(route);
    },
    onUnauthorized() {
      if (!authed || destroyed) return;
      authed = false;
      ui.closeAll();
      const path = router.parseHash().path;
      ui.toast('La sesión de administración ha terminado. Introduce el PIN de nuevo.', { type: 'warning' });
      redirect('/admin', pageIdOf(path) ? { next: path } : undefined);
    },
    destroy() {
      destroyed = true;
      authSeq += 1;
      unsubscribe();
      teardownShell();
      teardownAuth();
      clear(container);
    },
  };
}
