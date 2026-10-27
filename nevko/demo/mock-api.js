// Puts the demo backend (backend.js) behind the page's own network APIs, before the app
// starts:
//   - window.fetch answers every same-host URL whose path contains /api/ with a real
//     Response (JSON, same status codes and error format as the server), after a small
//     random latency so loading states look natural. Other URLs go to the network.
//   - window.EventSource for /api/events delivers the backend's `change` events
//     ({ type, toolIds }), like the server's SSE stream.
//   - other tabs of the demo receive the same events through a BroadcastChannel (local mode);
//     with shared data (store.js), every page learns about other devices' changes from the
//     store and receives a `resync` event.
//   - window.TRACKTOOL_DEMO tells the app it runs as a demo (public/js/demo.js).

import { handle, onChange } from './backend.js';
import {
  db,
  deviceCopyInfo,
  initStore,
  onModeChange,
  onRemoteChange,
  resetData,
  storeMode,
  uploadDeviceCopy,
} from './store.js';

const API_MARK = '/api/';
const CHANNEL_NAME = 'tracktool-demo';
const MIN_LATENCY_MS = 40;
const MAX_LATENCY_MS = 120;
const EVENT_DELAY_MS = 20;

const latency = () => MIN_LATENCY_MS + Math.floor(Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS + 1));
const sources = new Set();
let installing = null;
let channel = null;

/** Path relative to /api ('/tools/search') for a demo API URL, or null. */
function apiPathOf(url) {
  if (url.host !== window.location.host) return null;
  const at = url.pathname.lastIndexOf(API_MARK);
  if (at >= 0) return url.pathname.slice(at + API_MARK.length - 1);
  return url.pathname.endsWith('/api') ? '/' : null;
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function toBytes(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  return null; // FormData and streams are not used by the app
}

function toResponse({ status, body, headers = {} }) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function demoFetch(originalFetch) {
  return async function fetch(input, init = {}) {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    let url;
    try {
      url = new URL(request ? request.url : String(input), window.location.href);
    } catch {
      return originalFetch(input, init);
    }
    const path = apiPathOf(url);
    if (path === null) return originalFetch(input, init);

    const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? request?.headers ?? undefined);
    const signal = init.signal ?? request?.signal ?? null;
    const readBody = async () => {
      if (init.body !== undefined && init.body !== null) return toBytes(init.body);
      if (request && method !== 'GET' && method !== 'HEAD') return new Uint8Array(await request.clone().arrayBuffer());
      return null;
    };

    await wait(latency(), signal);
    const result = await handle({ method, path, query: url.searchParams, headers, readBody });
    if (signal?.aborted) throw abortError();
    return toResponse(result);
  };
}

// ---------------------------------------------------------------------------
// Server-sent events

function deliver(event) {
  const data = JSON.stringify({ type: event.type, toolIds: event.toolIds ?? [] });
  setTimeout(() => {
    for (const source of [...sources]) source.deliver(data);
  }, EVENT_DELAY_MS);
}

function createEventSource(OriginalEventSource) {
  class DemoEventSource extends EventTarget {
    constructor(url, init = undefined) {
      const target = new URL(String(url), window.location.href);
      if (apiPathOf(target) !== '/events' && OriginalEventSource) {
        return new OriginalEventSource(url, init);
      }
      super();
      this.url = target.href;
      this.withCredentials = Boolean(init?.withCredentials);
      this.readyState = DemoEventSource.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      sources.add(this);
      setTimeout(() => {
        if (this.readyState !== DemoEventSource.CONNECTING) return;
        this.readyState = DemoEventSource.OPEN;
        this.fire(new Event('open'));
      }, latency());
    }

    close() {
      this.readyState = DemoEventSource.CLOSED;
      sources.delete(this);
    }

    /** Sends one `change` event (JSON text). */
    deliver(data) {
      if (this.readyState !== DemoEventSource.OPEN) return;
      this.fire(new MessageEvent('change', { data, origin: window.location.origin, lastEventId: '' }));
    }

    fire(event) {
      const handler = this[`on${event.type}`];
      if (typeof handler === 'function') {
        try {
          handler.call(this, event);
        } catch (err) {
          console.error(err);
        }
      }
      this.dispatchEvent(event);
    }
  }
  for (const [name, value] of [['CONNECTING', 0], ['OPEN', 1], ['CLOSED', 2]]) {
    Object.defineProperty(DemoEventSource, name, { value });
    Object.defineProperty(DemoEventSource.prototype, name, { value });
  }
  return DemoEventSource;
}

// ---------------------------------------------------------------------------
// Install

function postToTabs(event) {
  if (storeMode() !== 'local') return; // shared data: the other pages follow the store
  try {
    channel?.postMessage(event);
  } catch {
    // Other tabs refresh on their next request anyway.
  }
}

/**
 * Loads the demo data (shared between devices when the viewer serves `db`, otherwise from this
 * device), replaces fetch and EventSource and publishes window.TRACKTOOL_DEMO. Safe to call twice.
 */
export function installDemo() {
  installing ??= install();
  return installing;
}

async function install() {
  await initStore();

  window.fetch = demoFetch(window.fetch.bind(window));
  window.EventSource = createEventSource(window.EventSource);

  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
    channel?.addEventListener('message', (message) => {
      if (message.data && typeof message.data.type === 'string') deliver(message.data);
    });
  } catch {
    channel = null;
  }

  onChange((event) => {
    deliver(event);
    postToTabs(event);
  });
  // Another device changed the shared data: the app refreshes everything it shows.
  onRemoteChange(() => deliver({ type: 'resync', toolIds: [] }));

  window.TRACKTOOL_DEMO = {
    get adminPin() {
      return db().adminPin;
    },
    operatorPin(id) {
      return db().operators.find((op) => op.id === Number(id))?.pin ?? null;
    },
    /** True while the data is shared between the user's devices (false: this device only). */
    get shared() {
      return storeMode() === 'shared';
    },
    /** fn(mode) when the shared data stops working during the visit. */
    onModeChange(fn) {
      return onModeChange(fn);
    },
    /** Data this device had before sharing ({ savedAt, operators, tools, inUse }), or null. */
    deviceCopy() {
      return deviceCopyInfo();
    },
    /** Replaces the shared data with this device's copy and reloads. Resolves false on failure. */
    async uploadDeviceCopy() {
      const done = await uploadDeviceCopy();
      if (done) window.location.reload();
      return done;
    },
    /** Sample data again (on every device when shared); reloads. */
    async reset() {
      await resetData();
      postToTabs({ type: 'import', toolIds: [] });
      window.location.reload();
    },
    /** Starts without tools (operators stay) and opens Importar; reloads. */
    async empty() {
      await resetData({ empty: true });
      postToTabs({ type: 'import', toolIds: [] });
      try {
        window.location.hash = '#/admin/importar';
      } catch {
        // the hash may be read-only in some frames: the app then opens on its default screen
      }
      window.location.reload();
    },
  };
}
