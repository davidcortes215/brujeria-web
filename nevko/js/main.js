// Entry point: theme, routes, layouts (sign-in / operator app / administration),
// session restore, real-time updates, shared-device sign-out, offline banner and
// service worker.
//
// Layouts
//   'login'     #/entrar                       plain shell + views/login.js
//   'operator'  #/buscar, #/lista, #/guardar   shell with tab bar + views/*.js
//               #/util/:id                     (tabs Buscar | En lista | Guardar)
//   'admin'     #/admin, #/admin/*             ./admin/admin.js (loaded on demand)
//
// View contract (operator/login views): mountX(root, { route, direction, restoreScroll })
// returns { destroy(), onChange?(event), reselect?(), focusTitle?() }.

import * as apiModule from './api.js';
import { ApiError, api } from './api.js';
import * as components from './components.js';
import { isDemo } from './demo.js';
import * as dom from './dom.js';
import { h } from './dom.js';
import * as fmt from './fmt.js';
import * as icons from './icons.js';
import { icon } from './icons.js';
import * as normalize from './normalize.js';
import { createPinPad } from './pinpad.js';
import { router } from './router.js';
import { canScan, scanCode } from './scanner.js';
import {
  clearSession,
  isSharedDevice,
  isSignedIn,
  onSharedDeviceChange,
  onPickChanges,
  onToolsLost,
  refreshMe,
  refreshMine,
  refreshMineSoon,
  refreshPicks,
  refreshPicksSoon,
  signOut,
  watchIdle,
} from './session.js';
import { store } from './store.js';
import { initTheme, theme } from './theme.js';
import * as ui from './ui.js';
import { createPlainShell, createShell } from './views/shell.js';
import { mountLogin } from './views/login.js';
import { mountPicklist } from './views/picklist.js';
import { mountPickup } from './views/pickup.js';
import { mountSearch } from './views/search.js';
import { mountTool } from './views/tool.js';

const OPERATOR_VIEWS = { buscar: mountSearch, lista: mountPicklist, util: mountTool, guardar: mountPickup };
const TAB_PATHS = { buscar: '/buscar', lista: '/lista', guardar: '/guardar' };
// Paths of the tabs before they were renamed ("Por coger" -> "En lista", "Recoger" -> "Guardar"):
// old links and bookmarks still land on the right tab.
const LEGACY_PATHS = { '/coger': '/lista', '/recoger': '/guardar' };

const appRoot = document.getElementById('app');

let layout = null; // 'login' | 'operator' | 'admin'
let shell = null; // current shell (login / operator)
let view = null; // mounted view instance
let activeTab = 'buscar';
let admin = null; // { instance, container, seq }
let adminSeq = 0;
let stopIdle = null; // inactivity watch (shared device)
let idleWarning = null; // toast shown before the idle sign-out

// ---------------------------------------------------------------------------
// Routes

router
  .define('entrar', '/entrar')
  .define('buscar', '/buscar')
  .define('util', '/util/:id')
  .define('lista', '/lista')
  .define('guardar', '/guardar')
  .define('admin', '/admin')
  .define('admin', '/admin/*')
  .setDefault('/buscar');

function isOperatorPath(path) {
  return /^\/(buscar|lista|guardar|util\/[^/]+)$/.test(path);
}

function handleRoute(route, previous, info) {
  // A stale emission (a newer hash change is already queued): let that one render.
  if (router.parseHash().path !== route.path) return;
  ui.closeAll();

  if (route.name === 'admin') {
    void showAdmin(route, info);
    return;
  }
  if (route.name === 'entrar') {
    showView('login', mountLogin, route, info);
    return;
  }
  if (!route.name && LEGACY_PATHS[route.path]) {
    router.navigate(LEGACY_PATHS[route.path], { replace: true, query: route.query });
    return;
  }
  if (!route.name) {
    router.navigate('/buscar', { replace: true });
    return;
  }
  if (!isSignedIn()) {
    router.navigate('/entrar', { replace: true, query: route.name === 'buscar' ? undefined : { next: route.path } });
    return;
  }
  if (route.name in TAB_PATHS) activeTab = route.name;
  showView('operator', OPERATOR_VIEWS[route.name], route, info);
}

// ---------------------------------------------------------------------------
// Layouts

function teardown() {
  if (view) {
    try {
      view.destroy?.();
    } catch (err) {
      console.error(err);
    }
    view = null;
  }
  shell?.destroy();
  shell = null;
  if (admin) {
    adminSeq += 1; // cancels a pending lazy load
    try {
      admin.instance?.destroy?.();
    } catch (err) {
      console.error(err);
    }
    admin = null;
  }
}

function ensureLayout(next) {
  if (layout === next && shell) return;
  teardown();
  layout = next;
  appRoot.classList.remove('boot');
  appRoot.removeAttribute('aria-busy');
  shell =
    next === 'operator'
      ? createShell({ onSwitchOperator: () => router.navigate('/entrar'), onSignOut: () => void leave(), onTab })
      : createPlainShell();
  appRoot.replaceChildren(shell.el);
}

function showView(nextLayout, mount, route, { direction }) {
  const layoutChanged = layout !== nextLayout;
  ensureLayout(nextLayout);
  if (view) {
    try {
      view.destroy?.();
    } catch (err) {
      console.error(err);
    }
    view = null;
  }
  shell.main.replaceChildren();
  shell.setActive?.(activeTab);

  const restoreScroll = () => window.scrollTo({ top: router.savedScroll(), left: 0 });
  if (direction !== 'back' && direction !== 'forward') window.scrollTo({ top: 0, left: 0 });

  view = mount(shell.main, { route, direction, restoreScroll }) ?? {};
  syncIdleWatch();

  // Move focus into the new screen (screen readers announce it) unless the view
  // already did (e.g. the search field).
  if (direction !== 'initial' || layoutChanged) {
    if (!shell.main.contains(document.activeElement)) {
      if (view.focusTitle) view.focusTitle();
      else shell.main.focus({ preventScroll: true });
    }
  }
}

function onTab(name, event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const current = router.current();
  if (current?.name === name) {
    view?.reselect?.();
    return;
  }
  const path = TAB_PATHS[name];
  if (router.previousPath() === path) router.back(path);
  else router.navigate(path);
}

async function leave() {
  await signOut();
  router.navigate('/entrar', { replace: true });
}

// ---------------------------------------------------------------------------
// Administration (lazy module)

/** Shared helpers handed to admin/admin.js (documented in public/js/README.md). */
function adminContext(container) {
  return {
    container,
    route: router.current(),
    api,
    request: api.request,
    ApiError,
    apiModule,
    router,
    navigate: router.navigate,
    h,
    dom,
    icon,
    icons,
    fmt,
    normalize,
    components,
    ui,
    toast: ui.toast,
    confirm: ui.confirm,
    theme,
    createPinPad,
    scanner: { canScan, scanCode },
    /** Leaves the administration area for the operator app. */
    exit: () => router.navigate('/buscar'),
  };
}

async function showAdmin(route, info) {
  if (layout === 'admin' && admin) {
    if (admin.instance) {
      try {
        admin.instance.update?.(route, info);
      } catch (err) {
        console.error(err);
      }
    }
    return; // still loading: mountAdmin() receives router.current()
  }

  teardown();
  layout = 'admin';
  syncIdleWatch();
  appRoot.classList.remove('boot');
  appRoot.removeAttribute('aria-busy');
  const container = h('div.admin-root');
  container.append(components.loadingBlock('Cargando administración…'));
  appRoot.replaceChildren(container);
  window.scrollTo({ top: 0, left: 0 });

  const seq = ++adminSeq;
  admin = { instance: null, container, seq };
  try {
    const module = await import('./admin/admin.js');
    if (seq !== adminSeq || layout !== 'admin') return;
    container.replaceChildren();
    const instance = await module.mountAdmin(container, adminContext(container));
    if (seq !== adminSeq || layout !== 'admin') {
      instance?.destroy?.();
      return;
    }
    admin.instance = instance ?? {};
  } catch (err) {
    if (seq !== adminSeq) return;
    console.error(err);
    container.replaceChildren(
      h(
        'div.main',
        components.errorState(
          err instanceof ApiError ? err : { message: 'No se ha podido cargar la administración. Comprueba la conexión y recarga la página.' },
          () => window.location.reload(),
          { title: 'Administración no disponible' },
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Session events

api.on('unauthorized', ({ admin: isAdmin, error }) => {
  if (isAdmin) {
    if (layout !== 'admin') return;
    const instance = admin?.instance;
    if (instance?.onUnauthorized) instance.onUnauthorized(error);
    else if (router.parseHash().path !== '/admin') router.navigate('/admin', { replace: true });
    else instance?.update?.(router.current(), { direction: 'replace' });
    return;
  }
  const hadSession = Boolean(store.get().operator);
  clearSession();
  if (isOperatorPath(router.parseHash().path)) router.navigate('/entrar', { replace: true });
  if (hadSession) ui.toast('Tu sesión ha terminado. Vuelve a identificarte.', { type: 'warning' });
});

/** Tools that left the operator's list because of someone else: explain what happened. */
onToolsLost(async (lost) => {
  if (lost.length > 3) {
    ui.toast(`${fmt.tools(lost.length)} ya no están a tu nombre.`, { type: 'warning' });
    return;
  }
  for (const tool of lost) {
    let message = `${tool.code} ya no está a tu nombre.`;
    try {
      const { tool: fresh } = await api.tool(tool.id);
      if (fresh.holder?.isMe) continue; // raced with a refresh: nothing was lost
      const last = Array.isArray(fresh.history) ? fresh.history[0] : null;
      if (fresh.holder) message = `${fresh.holder.name} ha pasado ${tool.code} a su nombre.`;
      else if (last?.returnType === 'forced') message = `Administración ha marcado ${tool.code} como guardado.`;
      else message = `${tool.code} se ha marcado como guardado desde otro dispositivo.`;
    } catch (err) {
      if (err?.status === 401) return;
    }
    ui.toast(message, { type: 'warning' });
  }
});

/** Listed tools that someone else took, or that became free again (the list shows it too). */
onPickChanges(({ taken, freed }) => {
  if (layout !== 'operator') return;
  if (taken.length > 2) {
    ui.toast(`Otros operarios han cogido ${fmt.tools(taken.length)} de tu lista.`, { type: 'warning' });
  } else {
    for (const tool of taken) ui.toast(`${tool.code} lo ha cogido ${tool.holder.name}`, { type: 'warning' });
  }
  if (freed.length > 2) ui.toast(`${fmt.tools(freed.length)} de tu lista vuelven a estar disponibles.`);
  else for (const tool of freed) ui.toast(`${tool.code} vuelve a estar disponible`);
});

// ---------------------------------------------------------------------------
// Shared device: sign out after SHARED_IDLE_MS without interaction (operator app only)

function dismissIdleWarning() {
  idleWarning?.dismiss();
  idleWarning = null;
}

function syncIdleWatch() {
  const wanted = layout === 'operator' && isSignedIn() && isSharedDevice();
  if (wanted && !stopIdle) {
    stopIdle = watchIdle({
      onWarn: () => {
        dismissIdleWarning();
        idleWarning = ui.toast('Sin actividad: la sesión se cerrará en 30 segundos.', {
          type: 'warning',
          duration: 0,
          action: { label: 'Seguir', onClick: () => {} }, // any interaction keeps the session
        });
      },
      onActive: dismissIdleWarning,
      onIdle: () => {
        stopIdle = null;
        dismissIdleWarning();
        void leave().then(() => ui.toast('Sesión cerrada por inactividad (dispositivo compartido).'));
      },
    });
  } else if (!wanted && stopIdle) {
    stopIdle();
    stopIdle = null;
    dismissIdleWarning();
  }
}

onSharedDeviceChange(syncIdleWatch);
store.select((state) => state.operator?.id ?? null, syncIdleWatch, { immediate: false });

// ---------------------------------------------------------------------------
// Real-time updates

api.subscribe((event) => {
  if (layout === 'operator' && isSignedIn()) {
    // 'picklist' events do not say whose list changed; any other change can move the holder
    // or the state of a listed tool.
    if (event.type !== 'picklist') refreshMineSoon();
    refreshPicksSoon();
    if (event.type === 'operators' || event.type === 'resync') void refreshMe();
  }
  if (layout === 'operator' || layout === 'login') {
    try {
      view?.onChange?.(event);
    } catch (err) {
      console.error(err);
    }
  }
});

// ---------------------------------------------------------------------------
// Offline banner

const banner = h(
  'div.offline-banner',
  { role: 'status', hidden: true },
  icon('wifi-off'),
  h('span.offline-banner-text', 'Sin conexión con el servidor — reintentando…'),
);
document.body.append(banner);

api.on('connectivity', (online) => {
  store.set({ online });
  banner.hidden = online;
  document.body.classList.toggle('is-offline', !online);
});

// ---------------------------------------------------------------------------
// Service worker (only where browsers allow it: HTTPS or localhost; never in the demo)

function registerServiceWorker() {
  if (isDemo() || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('No se ha podido registrar el service worker:', err);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

// ---------------------------------------------------------------------------
// Start

initTheme();
router.onChange(handleRoute);
if (isSignedIn()) {
  void refreshMe();
  void refreshMine();
  void refreshPicks();
}
router.start();
registerServiceWorker();
