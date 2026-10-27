// Minimal observable state for the operator app.
//
//   store.get()                      -> current state (treat as read-only)
//   store.set({ inUseCount: 3 })     -> shallow merge + notify
//   store.subscribe((state, prev) => ...) -> unsubscribe function
//   store.select(state => state.inUseCount, (count) => ...) -> runs when the selected value changes
//
// State shape:
//   operator     { id, name } | null     signed-in operator (persisted in localStorage 'tt.operator')
//   mine         Tool[]                  tools held by the operator, pick-up route order
//   mineLoaded   boolean                 `mine` reflects the server at least once
//   inUseCount   number                  mine.length (drives the Guardar badge)
//   picks        Tool[]                  pick list as the server last sent it (Tool & { addedAt }, route order)
//   pickIds      Set<number>             ids shown as "in the list": picks plus the changes still on
//                                        their way to the server (session.changePicks)
//   picksLoaded  boolean                 `picks` reflects the server at least once
//   pickCount    number                  pickIds.size (drives the En lista badge; GET /api/me before the first load)
//   online       boolean                 server reachable
//   search       { query, result, focus } last search (kept while navigating to a detail and back)

const OPERATOR_KEY = 'tt.operator';

function readOperator() {
  try {
    const value = JSON.parse(window.localStorage.getItem(OPERATOR_KEY) ?? 'null');
    return value && Number.isInteger(value.id) && typeof value.name === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function persistOperator(operator) {
  try {
    if (operator) window.localStorage.setItem(OPERATOR_KEY, JSON.stringify({ id: operator.id, name: operator.name }));
    else window.localStorage.removeItem(OPERATOR_KEY);
  } catch {
    // Storage unavailable (private mode): the in-memory state still works.
  }
}

function createStore(initial) {
  let state = initial;
  const subscribers = new Set();
  return {
    get: () => state,
    set(patch) {
      const previous = state;
      state = { ...state, ...patch };
      for (const fn of [...subscribers]) {
        try {
          fn(state, previous);
        } catch (err) {
          console.error(err);
        }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    select(selector, fn, { immediate = true } = {}) {
      let last = selector(state);
      if (immediate) fn(last);
      const unsubscribe = this.subscribe((next) => {
        const value = selector(next);
        if (!Object.is(value, last)) {
          last = value;
          fn(value);
        }
      });
      return unsubscribe;
    },
  };
}

export const store = createStore({
  operator: readOperator(),
  mine: [],
  mineLoaded: false,
  inUseCount: 0,
  picks: [],
  pickIds: new Set(),
  picksLoaded: false,
  picksError: null,
  pickCount: 0,
  online: true,
  search: { query: '', result: null, focus: true },
});

/** Updates the remembered search without notifying listeners of other slices. */
export function setSearch(patch) {
  store.set({ search: { ...store.get().search, ...patch } });
}

/** Clears the search and asks the Buscar screen to focus the empty field. */
export function resetSearch() {
  store.set({ search: { query: '', result: null, focus: true } });
}

export default store;
