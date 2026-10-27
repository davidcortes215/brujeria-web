// Spanish (Spain) formatting of dates, times, durations and counts.
// The server sends ISO 8601 UTC strings; everything here is shown in local time.
//
//   dateTime(iso)   'hoy 08:14' | 'ayer 17:02' | '25/09 08:14' | '25/09/2025 08:14'
//   clock(iso)      '08:14' (today) or dateTime(iso)
//   relative(iso)   'hace un momento' | 'hace 5 min' | 'hace 2 h' | 'hace 3 días'
//   duration(ms)    'menos de 1 min' | '45 min' | '2 h 16 min' | '1 d 3 h'
//   elapsed(iso)    duration(now - iso)

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad2 = (n) => String(n).padStart(2, '0');
const numberFormat = new Intl.NumberFormat('es-ES');

/** Accepts Date | ISO string | epoch ms; returns a valid Date or null. */
export function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole calendar days between two dates (local time). */
function dayDiff(date, now) {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY);
}

/** 'HH:MM' */
export function time(value) {
  const d = toDate(value);
  return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
}

/** 'DD/MM/AAAA' */
export function date(value) {
  const d = toDate(value);
  return d ? `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` : '';
}

/** 'DD/MM/AAAA HH:MM' */
export function absolute(value) {
  const d = toDate(value);
  return d ? `${date(d)} ${time(d)}` : '';
}

/** 'hoy' | 'ayer' | 'DD/MM' (this year) | 'DD/MM/AAAA' */
export function day(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const diff = dayDiff(d, now);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'ayer';
  if (d.getFullYear() === now.getFullYear()) return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  return date(d);
}

/** 'hoy 08:14' | 'ayer 17:02' | '25/09 08:14' | '25/09/2025 08:14' */
export function dateTime(value, now = new Date()) {
  const d = toDate(value);
  return d ? `${day(d, now)} ${time(d)}` : '';
}

/** '08:14' when it is today, otherwise dateTime(): 'ayer 17:02', '25/09 08:14'. */
export function clock(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  return dayDiff(d, now) === 0 ? time(d) : dateTime(d, now);
}

/** Human duration: 'menos de 1 min' | '45 min' | '2 h' | '2 h 16 min' | '1 d 3 h'. */
export function duration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < MINUTE) return 'menos de 1 min';
  if (value < HOUR) return `${Math.floor(value / MINUTE)} min`;
  if (value < DAY) {
    const h = Math.floor(value / HOUR);
    const m = Math.floor((value % HOUR) / MINUTE);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(value / DAY);
  const h = Math.floor((value % DAY) / HOUR);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** Duration since `value` until `now`. */
export function elapsed(value, now = new Date()) {
  const d = toDate(value);
  return d ? duration(now - d) : '';
}

/** Milliseconds since `value` (0 when invalid). */
export function elapsedMs(value, now = new Date()) {
  const d = toDate(value);
  return d ? Math.max(0, now - d) : 0;
}

/** 'hace un momento' | 'hace 5 min' | 'hace 2 h' | 'hace 1 día' | 'hace 3 días' */
export function relative(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const ms = now - d;
  if (ms < MINUTE) return 'hace un momento';
  if (ms < HOUR) return `hace ${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) return `hace ${Math.floor(ms / HOUR)} h`;
  const days = Math.floor(ms / DAY);
  return days === 1 ? 'hace 1 día' : `hace ${days} días`;
}

/** Formats a number with Spanish separators. */
export function number(value) {
  return numberFormat.format(Number(value) || 0);
}

/** '1 útil' / '3 útiles' */
export function count(n, singular, plural) {
  return `${number(n)} ${n === 1 ? singular : plural}`;
}

/** '1 útil' / '3 útiles' (the most common count in the app) */
export function tools(n) {
  return count(n, 'útil', 'útiles');
}

const NAME_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'da', 'do', 'dos', 'van', 'von']);

/** Initials for avatars: 'Juan Pérez' -> 'JP', 'María de la Cruz' -> 'MC', 'Ana' -> 'AN'. */
export function initials(name) {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !NAME_PARTICLES.has(w.toLowerCase()));
  if (words.length === 0) return '?';
  const letters = (word) => Array.from(word.replace(/[^\p{L}\p{N}]/gu, ''));
  if (words.length === 1) return letters(words[0]).slice(0, 2).join('').toUpperCase() || '?';
  const first = letters(words[0])[0] ?? '';
  const last = letters(words[words.length - 1])[0] ?? '';
  return `${first}${last}`.toUpperCase() || '?';
}

/** Stable avatar colour index (0-5) for a name. */
export function tone(name) {
  let hash = 0;
  for (const ch of String(name ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 6;
}

/** A waiting time in seconds: "45 s", "2 min", "4 min 30 s". */
export function wait(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Labels of checkout return types in the operator's history (operators say "guardar"). */
export const RETURN_TYPE_LABELS = Object.freeze({
  returned: 'Guardado',
  transferred: 'Pasado a otro operario',
  forced: 'Guardado por administración',
});

export function returnTypeLabel(type) {
  return RETURN_TYPE_LABELS[type] ?? 'Guardado';
}

/**
 * Location text for display: a hyphen between letters or digits ("AM-12") becomes a
 * non-breaking hyphen (U+2011), so identifiers are not split across lines.
 */
export function keepHyphens(text) {
  return String(text ?? '').replace(/([\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, '$1\u2011');
}

/** Font size bucket of a location shown in large type: null | 'long' | 'xlong'. */
export function locationLength(location) {
  const length = String(location ?? '').length;
  if (length > 30) return 'xlong';
  if (length > 16) return 'long';
  return null;
}

// ---------------------------------------------------------------------------
// Units and kits (SPEC §4 Tool: unitIndex, unitCount, container)

/** "Unidad 2 de 3" when the tool's code has several active units, otherwise ''. */
export function unitLabel(tool) {
  const index = Number(tool?.unitIndex);
  const total = Number(tool?.unitCount);
  return Number.isInteger(index) && index > 0 && total > 1 ? `Unidad ${index} de ${total}` : '';
}

/** Code plus its unit when the code has several: "VAS 6056 (unidad 2)"; otherwise the code. */
export function codeWithUnit(tool) {
  const code = String(tool?.code ?? '');
  const index = Number(tool?.unitIndex);
  return Number.isInteger(index) && index > 0 && Number(tool?.unitCount) > 1 ? `${code} (unidad ${index})` : code;
}

/** Where the kit holding a tool is (Tool.container): "AR1", "AR1 · AR2"; '' if unknown. */
export function containerPlaces(container) {
  const locations = Array.isArray(container?.locations) ? container.locations : [];
  return [...new Set(locations.map((location) => String(location ?? '').trim()).filter(Boolean))].join(' · ');
}

/** "El juego VAT 8015 está en AR1" (Tool.container), or '' when the tool is not inside a kit. */
export function containerSentence(container) {
  const code = String(container?.code ?? '').trim();
  if (!code) return '';
  const places = containerPlaces(container);
  return places ? `El juego ${code} está en ${places}` : `El juego ${code} no tiene ubicación asignada`;
}
