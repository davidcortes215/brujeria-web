// Demonstration build switch. The published demo (demo/, scripts/build-demo.js) sets
// window.TRACKTOOL_DEMO before main.js loads: `true`, or an object with helpers
// ({ adminPin, operatorPin(id), shared, reset(), empty(), deviceCopy(), uploadDeviceCopy() }).
// `shared` is true when the demo data is shared between the user's devices (the published
// page's shared store), false when it is kept on this device only. The installed application
// never sets it, so every function here is a no-op there.

function config() {
  try {
    return globalThis.TRACKTOOL_DEMO ?? null;
  } catch {
    return null;
  }
}

/** True in the browser-only demonstration (no server behind the API). */
export function isDemo() {
  return Boolean(config());
}

/** PIN hint for the sign-in screens of the demo: 'admin' or an operator id. Null when unknown. */
export function demoPin(target) {
  const demo = config();
  if (!demo || typeof demo !== 'object') return null;
  try {
    const pin = target === 'admin' ? demo.adminPin : demo.operatorPin?.(target);
    return typeof pin === 'string' && pin ? pin : null;
  } catch {
    return null;
  }
}

/** True when the demo data is shared between the user's devices (false: this device only). */
export function isSharedDemo() {
  const demo = config();
  try {
    return Boolean(demo && typeof demo === 'object' && demo.shared);
  } catch {
    return false;
  }
}

/** True when the demo can be reset to its sample data. */
export function canResetDemo() {
  const demo = config();
  return Boolean(demo && typeof demo === 'object' && typeof demo.reset === 'function');
}

/** Restores the sample data of the demo (reloads the page). */
export function resetDemo() {
  const demo = config();
  if (demo && typeof demo.reset === 'function') demo.reset();
}

/** True when the demo can start without tools (to try a real catalogue). */
export function canEmptyDemo() {
  const demo = config();
  return Boolean(demo && typeof demo === 'object' && typeof demo.empty === 'function');
}

/** Asks for confirmation (app dialog) and empties the demo catalogue (reloads the page). */
export async function confirmEmptyDemo() {
  if (!canEmptyDemo()) return;
  const shared = isSharedDemo();
  const { confirm, toast } = await import('./ui.js');
  const ok = await confirm({
    title: '¿Empezar sin útiles?',
    message: shared
      ? 'Se borran los útiles, préstamos, listas e historial en todos tus dispositivos donde esté abierta la demostración. Los operarios se mantienen. Después podrás importar tu listado en Importar.'
      : 'Se borran de este dispositivo los útiles, préstamos, listas e historial. Los operarios se mantienen. Después podrás importar tu listado en Importar.',
    confirmLabel: 'Vaciar catálogo',
    icon: 'trash',
    danger: true,
  });
  if (!ok) return;
  if (shared) toast('Vaciando el catálogo en todos tus dispositivos…', { duration: 0 });
  config().empty();
}

/** Asks for confirmation (app dialog) and resets the demo. */
export async function confirmResetDemo() {
  if (!canResetDemo()) return;
  const shared = isSharedDemo();
  const { confirm, toast } = await import('./ui.js');
  const ok = await confirm({
    title: '¿Restablecer la demostración?',
    message: shared
      ? 'Se descartan los cambios (préstamos, importaciones, operarios…) en todos tus dispositivos donde esté abierta la demostración y se cargan de nuevo los datos de ejemplo.'
      : 'Se descartan los cambios hechos en este dispositivo (préstamos, importaciones, operarios…) y se cargan de nuevo los datos de ejemplo.',
    confirmLabel: 'Restablecer',
    icon: 'refresh',
    danger: true,
  });
  if (!ok) return;
  if (shared) toast('Restableciendo la demostración en todos tus dispositivos…', { duration: 0 });
  resetDemo();
}

/**
 * Shared demo only: the data this device had before sharing, as a sentence for Ajustes
 * ('guardada el 28/09/2026 20:15: 12 operarios y 150 útiles'), or null when there is none.
 */
export function demoDeviceCopy() {
  const demo = config();
  if (!isSharedDemo() || typeof demo.deviceCopy !== 'function') return null;
  let copy = null;
  try {
    copy = demo.deviceCopy();
  } catch {
    return null;
  }
  if (!copy) return null;
  const saved = copy.savedAt ? new Date(copy.savedAt) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const when =
    saved && !Number.isNaN(saved.getTime())
      ? `guardada el ${pad(saved.getDate())}/${pad(saved.getMonth() + 1)}/${saved.getFullYear()} ${pad(saved.getHours())}:${pad(saved.getMinutes())}`
      : 'guardada antes de compartir';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return `${when}: ${plural(copy.operators, 'operario', 'operarios')} y ${plural(copy.tools, 'útil', 'útiles')}`;
}

/** Asks for confirmation and replaces the shared data with this device's copy (reloads). */
export async function confirmUploadDeviceCopy() {
  const demo = config();
  const summary = demoDeviceCopy();
  if (!summary || typeof demo.uploadDeviceCopy !== 'function') return;
  const { confirm, toast } = await import('./ui.js');
  const ok = await confirm({
    title: '¿Subir los datos de este dispositivo?',
    message: `Los datos compartidos se sustituyen en todos tus dispositivos por la copia de este (${summary}). Los demás dispositivos tendrán que volver a identificarse.`,
    confirmLabel: 'Subir datos',
    icon: 'upload',
    danger: true,
  });
  if (!ok) return;
  const busy = toast('Subiendo los datos de este dispositivo…', { duration: 0 });
  const done = await demo.uploadDeviceCopy();
  if (!done) busy.dismiss(); // the store explains what failed
}
