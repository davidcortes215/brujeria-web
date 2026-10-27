// Actions shared by Buscar, En lista and the detail:
//   - taking tools (checkout without transfer): "Coger", "Cogido", "Coger los N", "Coger todos",
//     "Usar este útil". One place for the messages, the "Deshacer" of each toast and the pick
//     list bookkeeping: a checkout takes the tool out of the operator's list on the server;
//     "Deshacer" returns it and marks it again when it was listed.
//   - marking / unmarking a tool in the pick list ("A la lista", "Añadir a la lista").

import { api } from './api.js';
import * as fmt from './fmt.js';
import {
  addPicks,
  cancelExpectedRemoval,
  currentOperator,
  expectRemoval,
  forgetPicks,
  refreshMine,
  refreshPicks,
  removePick,
} from './session.js';
import { store } from './store.js';
import { toast, toastError } from './ui.js';

/** "UT-0012 ahora está a nombre de Juan Pérez" / "3 útiles ahora están a nombre de …" (devices can be shared). */
export function nowHeldText(tools) {
  const name = currentOperator()?.name;
  const owner = name ? `a nombre de ${name}` : 'a tu nombre';
  return tools.length === 1 ? `${tools[0].code} ahora está ${owner}` : `${fmt.tools(tools.length)} ahora están ${owner}`;
}

const REASONS = {
  HELD_BY_OTHER: (item) => (item.holder?.name ? `lo tiene ${item.holder.name}` : 'lo tiene otro operario'),
  TOOL_INACTIVE: () => 'está dado de baja',
  NOT_FOUND: () => 'ya no existe',
};

const reasonOf = (item) => (REASONS[item.reason] ?? (() => 'no está disponible'))(item);

/**
 * Why some tools could not be taken (skipped of POST /api/me/checkout):
 * "CAL-061 no se ha podido coger: lo tiene Juan Pérez." /
 * "No se han podido coger 2 útiles: CAL-061 (lo tiene Juan Pérez), UT-0012 (está dado de baja)."
 */
export function skippedText(skipped) {
  if (skipped.length === 1) return `${skipped[0].code ?? 'Un útil'} no se ha podido coger: ${reasonOf(skipped[0])}.`;
  const shown = skipped.slice(0, 4).map((item) => `${item.code ?? 'un útil'} (${reasonOf(item)})`);
  const more = skipped.length > shown.length ? ` y ${skipped.length - shown.length} más` : '';
  return `No se han podido coger ${fmt.tools(skipped.length)}: ${shown.join(', ')}${more}.`;
}

/** Warning toast for the tools that could not be taken (nothing when there are none). */
export function reportSkipped(skipped) {
  if (!skipped?.length) return;
  toast(skippedText(skipped), { type: 'warning', duration: skipped.length > 1 ? 8000 : 5000 });
}

/** Bookkeeping after this operator took tools (also a transfer): held list and pick list. */
export function afterTaking(ids) {
  cancelExpectedRemoval(ids);
  forgetPicks(ids);
  void refreshMine();
  void refreshPicks();
}

/**
 * Takes one tool. Resolves with the updated Tool (toast with "Deshacer" shown); rejects with
 * the ApiError (409 HELD_BY_OTHER | TOOL_INACTIVE, 404...) without showing anything.
 * `onUndone(tools)` runs after a successful "Deshacer" (the caller may be gone by then).
 */
export async function takeTool(tool, { onUndone } = {}) {
  const operatorId = currentOperator()?.id ?? null;
  const listed = store.get().pickIds.has(tool.id);
  const { tool: updated } = await api.checkout(tool.id);
  afterTaking([tool.id]);
  toast(nowHeldText([updated]), {
    type: 'success',
    action: { label: 'Deshacer', onClick: () => void undoTake([updated], { operatorId, relist: listed ? [tool.id] : [], onUndone }) },
  });
  return updated;
}

/**
 * Takes several tools at once (POST /api/me/checkout). Resolves with { taken, skipped }: the
 * success toast (with "Deshacer") and the warning for the skipped ones are already shown.
 * Rejects with the ApiError when the request itself failed.
 */
export async function takeTools(tools, { onUndone } = {}) {
  const operatorId = currentOperator()?.id ?? null;
  const ids = tools.map((tool) => tool.id);
  const { pickIds } = store.get();
  const listed = ids.filter((id) => pickIds.has(id));
  const result = await api.checkoutMany(ids);
  const taken = Array.isArray(result?.taken) ? result.taken : [];
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  afterTaking(taken.map((tool) => tool.id));
  if (taken.length) {
    const takenIds = new Set(taken.map((tool) => tool.id));
    toast(nowHeldText(taken), {
      type: 'success',
      action: {
        label: 'Deshacer',
        onClick: () => void undoTake(taken, { operatorId, relist: listed.filter((id) => takenIds.has(id)), onUndone }),
      },
    });
  }
  reportSkipped(skipped);
  return { taken, skipped };
}

/**
 * "Deshacer" of a take: returns the tools and marks again the ones that were in the pick list
 * (`relist`). Only for the operator who took them (the device may have changed hands).
 */
export async function undoTake(tools, { operatorId, relist = [], onUndone } = {}) {
  if (store.get().operator?.id !== operatorId) {
    toast('No se puede deshacer: ha cambiado el operario.', { type: 'warning' });
    return;
  }
  const ids = tools.map((tool) => tool.id);
  expectRemoval(ids);
  let returned;
  try {
    if (ids.length === 1) {
      await api.returnTool(ids[0]);
      returned = tools;
    } else {
      const result = await api.returnMine(ids);
      const back = new Set((result?.returned ?? []).map((tool) => tool.id));
      returned = tools.filter((tool) => back.has(tool.id));
      if (returned.length < tools.length) {
        toast(`${fmt.tools(tools.length - returned.length)} ya no estaban a tu nombre.`, { type: 'warning' });
      }
    }
  } catch (err) {
    cancelExpectedRemoval(ids);
    if (err.code === 'HELD_BY_OTHER') toast(`No se puede deshacer: ${err.message}`, { type: 'warning' });
    else toastError(err);
    void refreshMine();
    return;
  }
  const returnedIds = new Set(returned.map((tool) => tool.id));
  const again = relist.filter((id) => returnedIds.has(id));
  let relisted = false;
  if (again.length) {
    try {
      const result = await addPicks(again);
      const refused = new Set((result?.skipped ?? []).map((item) => item.toolId));
      relisted = again.some((id) => !refused.has(id));
      reportNotRelisted(result?.skipped);
    } catch (err) {
      toastError(err, 'No se han podido volver a marcar en tu lista.');
    }
  }
  if (returned.length === 1) {
    toast(`${returned[0].code} vuelve a estar disponible${relisted ? ' y en tu lista' : ''}`);
  } else if (returned.length > 1) {
    toast(`${fmt.tools(returned.length)} vuelven a estar disponibles${relisted ? ' y en tu lista' : ''}`);
  }
  void refreshMine();
  if (returned.length) onUndone?.(returned);
}

// ---------------------------------------------------------------------------
// Pick list marks

const MARK_REFUSED = {
  ALREADY_MINE: (code) => `${code} ya lo tienes tú: no hace falta añadirlo a tu lista.`,
  TOOL_INACTIVE: (code) => `${code} está dado de baja: no se puede añadir a tu lista.`,
  NOT_FOUND: (code) => `${code} ya no existe.`,
};

const RELIST_REASONS = { ALREADY_MINE: 'ya lo tienes tú', TOOL_INACTIVE: 'está dado de baja', NOT_FOUND: 'ya no existe' };

/**
 * Warning for the tools a "Deshacer" could not mark again (skipped of POST /api/me/picklist,
 * e.g. deactivated meanwhile): "CAL-207 no ha vuelto a tu lista: está dado de baja.".
 */
export function reportNotRelisted(skipped) {
  if (!skipped?.length) return;
  const why = (item) => RELIST_REASONS[item.reason] ?? 'no se puede añadir';
  let text;
  if (skipped.length === 1) {
    text = `${skipped[0].code ?? 'Un útil'} no ha vuelto a tu lista: ${why(skipped[0])}.`;
  } else {
    const shown = skipped.slice(0, 4).map((item) => `${item.code ?? 'un útil'} (${why(item)})`);
    const more = skipped.length > shown.length ? ` y ${skipped.length - shown.length} más` : '';
    text = `${fmt.tools(skipped.length)} no han vuelto a tu lista: ${shown.join(', ')}${more}.`;
  }
  toast(text, { type: 'warning', duration: skipped.length > 1 ? 8000 : 5000 });
}

/**
 * Adds the tool to the pick list, or takes it out when it is listed. The mark changes at
 * once. Resolves with true (listed now), false (not listed now) or null when nothing changed
 * (refused or failed: the reason has been shown).
 */
export async function togglePick(tool) {
  try {
    if (store.get().pickIds.has(tool.id)) {
      await removePick(tool.id);
      return false;
    }
    const result = await addPicks([tool.id]);
    const refused = result?.skipped?.find((item) => item.toolId === tool.id);
    if (refused) {
      const text = MARK_REFUSED[refused.reason] ?? ((code) => `${code} no se puede añadir a tu lista.`);
      toast(text(refused.code ?? tool.code), { type: 'warning' });
      return null;
    }
    return true;
  } catch (err) {
    toastError(err);
    return null;
  }
}
