// Inline SVG icon set (24 x 24 grid, 2 px round strokes, Lucide-like style).
// Drawn for Nevko; no external icon font or sprite is needed.
//
//   icon('search')                         -> <svg class="icon icon-search" ...>
//   icon('check', { size: 16, className: 'text-success', title: 'Disponible' })
//   logoMark({ size: 30 })                 -> the app logo (same geometry as /icons/icon.svg)

import { svg } from './dom.js';

// Gear outline generated from polar coordinates (8 teeth).
function gearPath() {
  const cx = 12;
  const cy = 12;
  const rOuter = 10;
  const rInner = 7.6;
  const teeth = 8;
  const halfTop = 0.2; // half angular width of a tooth at the tip (rad)
  const halfBase = 0.3; // half angular width of a tooth at its base (rad)
  const point = (angle, r) => `${(cx + r * Math.cos(angle)).toFixed(2)} ${(cy + r * Math.sin(angle)).toFixed(2)}`;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a = (i * 2 * Math.PI) / teeth - Math.PI / 2;
    d += `${i === 0 ? 'M' : 'L'}${point(a - halfBase, rInner)}`;
    d += `L${point(a - halfTop, rOuter)}L${point(a + halfTop, rOuter)}L${point(a + halfBase, rInner)}`;
    const next = ((i + 1) * 2 * Math.PI) / teeth - Math.PI / 2;
    d += `A${rInner} ${rInner} 0 0 1 ${point(next - halfBase, rInner)}`;
  }
  return `${d}Z`;
}

const p = (d) => ['path', { d }];
const c = (cx, cy, r) => ['circle', { cx, cy, r }];
const r = (x, y, width, height, rx = 0) => ['rect', { x, y, width, height, rx }];

const ICONS = {
  // Navigation & actions
  search: [c(11, 11, 7), p('M20.5 20.5 16 16')],
  'search-x': [c(11, 11, 7), p('M20.5 20.5 16 16'), p('m8.5 8.5 5 5'), p('m13.5 8.5-5 5')],
  x: [p('M18 6 6 18'), p('m6 6 12 12')],
  check: [p('M20 6 9 17l-5-5')],
  'check-check': [p('M16.5 6.5 7 16l-4.5-4.5'), p('m21.5 8.5-8 8-1.8-1.8')],
  'check-circle': [c(12, 12, 9.5), p('m8 12.3 2.7 2.7L16 9.7')],
  'x-circle': [c(12, 12, 9.5), p('m15 9-6 6'), p('m9 9 6 6')],
  plus: [p('M12 5v14'), p('M5 12h14')],
  minus: [p('M5 12h14')],
  'arrow-left': [p('M19 12H5'), p('m12 19-7-7 7-7')],
  'arrow-right': [p('M5 12h14'), p('m12 5 7 7-7 7')],
  'chevron-right': [p('m9 6 6 6-6 6')],
  'chevron-left': [p('m15 6-6 6 6 6')],
  'chevron-down': [p('m6 9 6 6 6-6')],
  'chevron-up': [p('m18 15-6-6-6 6')],
  undo: [p('M9 14 4 9l5-5'), p('M4 9h10.5a5.5 5.5 0 0 1 0 11H11')],
  refresh: [
    p('M20.5 12a8.5 8.5 0 0 1-14.8 5.7L3.5 15.5'),
    p('M3.5 20.5v-5h5'),
    p('M3.5 12a8.5 8.5 0 0 1 14.8-5.7l2.2 2.2'),
    p('M20.5 3.5v5h-5'),
  ],
  transfer: [p('m16 3 4 4-4 4'), p('M20 7H4'), p('m8 21-4-4 4-4'), p('M4 17h16')],
  'external-link': [p('M15 3h6v6'), p('M10 14 21 3'), p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')],
  'more-vertical': [c(12, 5, 1), c(12, 12, 1), c(12, 19, 1)],
  'more-horizontal': [c(5, 12, 1), c(12, 12, 1), c(19, 12, 1)],
  filter: [p('M21.5 3.5h-19l7.6 9V19l3.8 1.9v-8.4z')],
  sliders: [
    p('M21 4h-7'),
    p('M10 4H3'),
    p('M21 12h-9'),
    p('M8 12H3'),
    p('M21 20h-5'),
    p('M12 20H3'),
    p('M14 2v4'),
    p('M8 10v4'),
    p('M16 18v4'),
  ],
  menu: [p('M4 6h16'), p('M4 12h16'), p('M4 18h16')],
  list: [p('M8.5 6H21'), p('M8.5 12H21'), p('M8.5 18H21'), p('M3.5 6h.01'), p('M3.5 12h.01'), p('M3.5 18h.01')],
  'list-plus': [p('M3.5 6h13'), p('M3.5 12h13'), p('M3.5 18h8'), p('M18 15v6'), p('M15 18h6')],
  'list-check': [p('M3.5 6h13'), p('M3.5 12h13'), p('M3.5 18h7'), p('m14.5 18 2.5 2.5 4.5-4.5')],
  'clipboard-list': [
    r(8, 2.5, 8, 4, 1),
    p('M16 4.5h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2'),
    p('M12 11h4'),
    p('M12 16h4'),
    p('M8 11h.01'),
    p('M8 16h.01'),
  ],
  copy: [r(8, 8, 13, 13, 2), p('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')],
  edit: [p('M16.9 3.6a2.3 2.3 0 0 1 3.3 3.3L7.5 19.6l-4.3 1.2 1.2-4.3z'), p('m15 5.5 3.5 3.5')],
  trash: [
    p('M3.5 6h17'),
    p('M18.5 6v13.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6'),
    p('M8.5 6V4.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V6'),
    p('M10 11v6'),
    p('M14 11v6'),
  ],
  upload: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m17 8-5-5-5 5'), p('M12 3v12')],
  download: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m7 10 5 5 5-5'), p('M12 15V3')],
  'log-out': [p('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), p('m16 17 5-5-5-5'), p('M21 12H9')],
  'log-in': [p('M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4'), p('m10 17 5-5-5-5'), p('M15 12H3')],
  delete: [p('M21 5H9.2a1 1 0 0 0-.8.4L3 12l5.4 6.6a1 1 0 0 0 .8.4H21a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z'), p('m17.5 9.5-5 5'), p('m12.5 9.5 5 5')],

  // Objects
  'map-pin': [p('M12 21.5s-7-6-7-11.5a7 7 0 0 1 14 0c0 5.5-7 11.5-7 11.5z'), c(12, 10, 2.5)],
  map: [p('M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z'), p('M9 4v14'), p('M15 6v14')],
  route: [c(6, 19, 2.5), c(18, 5, 2.5), p('M8.5 19h8a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7h8')],
  package: [
    p('M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z'),
    p('M3.3 7 12 12l8.7-5'),
    p('M12 22V12'),
    p('m7.5 4.3 9 5.1'),
  ],
  box: [
    p('M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z'),
    p('M3.3 7 12 12l8.7-5'),
    p('M12 22V12'),
  ],
  archive: [r(2.5, 3.5, 19, 5, 1.5), p('M4.5 8.5v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-10'), p('M10 12.5h4')],
  inbox: [
    p('M22 12h-6l-2 3h-4l-2-3H2'),
    p('M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z'),
  ],
  wrench: [
    p('M14.5 6.5a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.4-3.4a5.5 5.5 0 0 1-7.3 7.3l-6.4 6.4a2.1 2.1 0 0 1-3-3l6.4-6.4a5.5 5.5 0 0 1 7.3-7.3z'),
  ],
  tool: [
    p('M14.5 6.5a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.4-3.4a5.5 5.5 0 0 1-7.3 7.3l-6.4 6.4a2.1 2.1 0 0 1-3-3l6.4-6.4a5.5 5.5 0 0 1 7.3-7.3z'),
  ],
  'file-text': [
    p('M14 2.5H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-11z'),
    p('M14 2.5v6h6'),
    p('M16 13H8'),
    p('M16 17H8'),
    p('M10 9H8'),
  ],
  file: [p('M14 2.5H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-11z'), p('M14 2.5v6h6')],
  database: [
    ['ellipse', { cx: 12, cy: 5, rx: 8.5, ry: 3 }],
    p('M3.5 5v14c0 1.7 3.8 3 8.5 3s8.5-1.3 8.5-3V5'),
    p('M3.5 12c0 1.7 3.8 3 8.5 3s8.5-1.3 8.5-3'),
  ],
  settings: [p(gearPath()), c(12, 12, 3)],
  shield: [p('M12 21.5s8-3.8 8-9.8V5.2l-8-2.9-8 2.9v6.5c0 6 8 9.8 8 9.8z')],
  'shield-check': [p('M12 21.5s8-3.8 8-9.8V5.2l-8-2.9-8 2.9v6.5c0 6 8 9.8 8 9.8z'), p('m9 11.8 2.2 2.2 4-4.2')],
  lock: [r(4, 11, 16, 10, 2), p('M8 11V7a4 4 0 0 1 8 0v4')],
  unlock: [r(4, 11, 16, 10, 2), p('M8 11V7a4 4 0 0 1 7.8-1.2')],
  key: [c(7.5, 15.5, 4.5), p('m10.7 12.3 9.8-9.8'), p('m15.5 7.5 3 3'), p('m18 5 2.5 2.5')],
  history: [p('M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5'), p('M3.5 3.5v5h5'), p('M12 7.5V12l3.5 2')],
  clock: [c(12, 12, 9.5), p('M12 6.5V12l3.5 2')],
  calendar: [r(3.5, 4.5, 17, 16.5, 2), p('M16 2.5v4'), p('M8 2.5v4'), p('M3.5 10h17')],
  user: [c(12, 8, 4), p('M4.5 21v-1a6 6 0 0 1 6-6h3a6 6 0 0 1 6 6v1')],
  users: [
    c(9, 8, 3.5),
    p('M2.5 20.5V20a5.5 5.5 0 0 1 5.5-5.5h2a5.5 5.5 0 0 1 5.5 5.5v.5'),
    p('M15.5 4.6a3.5 3.5 0 0 1 0 6.8'),
    p('M18 14.6a5.5 5.5 0 0 1 3.5 5.1v.8'),
  ],
  'user-plus': [c(9, 8, 3.5), p('M2.5 20.5V20a5.5 5.5 0 0 1 5.5-5.5h2a5.5 5.5 0 0 1 5.5 5.5v.5'), p('M19 8v6'), p('M22 11h-6')],
  home: [p('M3.5 10.5 12 3.5l8.5 7V20a1.5 1.5 0 0 1-1.5 1.5h-4.5V15h-5v6.5H5A1.5 1.5 0 0 1 3.5 20z')],
  dashboard: [r(3, 3, 7.5, 9, 1.5), r(13.5, 3, 7.5, 5, 1.5), r(13.5, 11, 7.5, 10, 1.5), r(3, 15, 7.5, 6, 1.5)],
  grid: [r(3, 3, 7.5, 7.5, 1.5), r(13.5, 3, 7.5, 7.5, 1.5), r(3, 13.5, 7.5, 7.5, 1.5), r(13.5, 13.5, 7.5, 7.5, 1.5)],
  smartphone: [r(6, 2, 12, 20, 2.5), p('M11 18h2')],
  monitor: [r(2.5, 3.5, 19, 13, 2), p('M8 21h8'), p('M12 16.5V21')],
  link: [p('M10 13.5a4.5 4.5 0 0 0 6.4.5l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7'), p('M14 10.5a4.5 4.5 0 0 0-6.4-.5l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.7-1.7')],

  // Scanning
  scan: [
    p('M3 7.5V5.5a2.5 2.5 0 0 1 2.5-2.5h2'),
    p('M16.5 3h2A2.5 2.5 0 0 1 21 5.5v2'),
    p('M21 16.5v2a2.5 2.5 0 0 1-2.5 2.5h-2'),
    p('M7.5 21h-2A2.5 2.5 0 0 1 3 18.5v-2'),
    p('M7.5 8v8'),
    p('M10.5 8v8'),
    p('M13.5 8v8'),
    p('M16.5 8v8'),
  ],
  'qr-code': [
    r(3, 3, 7, 7, 1),
    r(14, 3, 7, 7, 1),
    r(3, 14, 7, 7, 1),
    p('M14 14h3v3h-3z'),
    p('M21 14v.01'),
    p('M17.5 20.5H21V17'),
    p('M14 20.5v.01'),
  ],
  camera: [p('M14.5 4h-5L7.5 7H4.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z'), c(12, 13, 3.5)],
  flashlight: [p('M18 6 6 6'), p('M8 6v2.5l2 3V21h4v-9.5l2-3V6'), p('M8 2.5h8V6H8z'), p('M12 14v2')],

  // Status & feedback
  info: [c(12, 12, 9.5), p('M12 16v-4.5'), p('M12 8h.01')],
  'alert-circle': [c(12, 12, 9.5), p('M12 7.5V12'), p('M12 16h.01')],
  'alert-triangle': [
    p('M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'),
    p('M12 9v4.5'),
    p('M12 17h.01'),
  ],
  'wifi-off': [
    p('m2.5 2.5 19 19'),
    p('M8.6 16.4a5 5 0 0 1 6.2-.6'),
    p('M5 12.9a10 10 0 0 1 4.4-2.4'),
    p('M14.2 10.3A10 10 0 0 1 19 12.9'),
    p('M2 8.8a15 15 0 0 1 4-2.6'),
    p('M10.4 5.1A15 15 0 0 1 22 8.8'),
    p('M12 20h.01'),
  ],
  wifi: [p('M5 12.9a10 10 0 0 1 14 0'), p('M8.5 16.4a5 5 0 0 1 7 0'), p('M2 8.8a15 15 0 0 1 20 0'), p('M12 20h.01')],
  eye: [p('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z'), c(12, 12, 3)],
  'eye-off': [
    p('M9.9 4.2A10 10 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-2.2 3.2'),
    p('M6.6 6.6A17 17 0 0 0 2 12s3.6 8 10 8a10 10 0 0 0 5.4-1.6'),
    p('M14.1 14.1a3 3 0 1 1-4.2-4.2'),
    p('m2.5 2.5 19 19'),
  ],

  // Theme
  sun: [
    c(12, 12, 4),
    p('M12 2v2'),
    p('M12 20v2'),
    p('m4.9 4.9 1.4 1.4'),
    p('m17.7 17.7 1.4 1.4'),
    p('M2 12h2'),
    p('M20 12h2'),
    p('m6.3 17.7-1.4 1.4'),
    p('m19.1 4.9-1.4 1.4'),
  ],
  moon: [p('M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a6.8 6.8 0 0 0 11 11z')],
  contrast: [c(12, 12, 9.5), p('M12 2.5v19a9.5 9.5 0 0 0 0-19z')],
};

export const iconNames = Object.freeze(Object.keys(ICONS));

/**
 * Returns an <svg> icon element.
 * @param {string} name one of iconNames
 * @param {object} [options]
 * @param {number} [options.size=20] width/height in px
 * @param {string} [options.className] extra classes
 * @param {string} [options.title] accessible label; without it the icon is aria-hidden
 * @param {number} [options.strokeWidth=2]
 */
export function icon(name, { size = 20, className = '', title = '', strokeWidth = 2 } = {}) {
  const shapes = ICONS[name];
  if (!shapes) console.warn(`icon(): icono desconocido «${name}»`);
  const el = svg(
    'svg',
    {
      class: ['icon', `icon-${name}`, className],
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': strokeWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      focusable: 'false',
      'aria-hidden': title ? null : 'true',
      role: title ? 'img' : null,
      'aria-label': title || null,
    },
    (shapes ?? []).map(([tag, attrs]) => svg(tag, attrs)),
  );
  return el;
}

// ---------------------------------------------------------------------------
// App logo: a map pin whose head is an open-end spanner holding an orange nut.
// Unified logo colours (design/logo/README.md): tile #5B8DEF, pin #FFFFFF, nut #F97316.
// Same geometry as public/icons/icon.svg (sources in design/logo/).

/** The Nevko logo mark as inline SVG. */
export function logoMark({ size = 30, className = '', title = '' } = {}) {
  return svg(
    'svg',
    {
      class: ['brand-mark', className],
      width: size,
      height: size,
      viewBox: '0 0 1024 1024',
      focusable: 'false',
      'aria-hidden': title ? null : 'true',
      role: title ? 'img' : null,
      'aria-label': title || null,
    },
    svg('rect', { width: 1024, height: 1024, rx: 228, fill: '#5B8DEF' }),
    svg('path', { fill: '#FFFFFF', d: 'M526.31 847.95A17.01 17.01 0 0 1 497.69 847.95L307.57 552.04A242.99 242.99 0 0 1 405.32 202.38A19.44 19.44 0 0 1 421.14 201.82L475.02 223.59A12.15 12.15 0 0 1 481.73 239.4L424.38 381.36A7.29 7.29 0 0 0 425.4 388.57L485.86 465.96A7.29 7.29 0 0 0 492.61 468.69L589.86 455.02A7.29 7.29 0 0 0 595.61 450.54L652.96 308.58A12.15 12.15 0 0 1 668.77 301.87L729.41 326.37A19.44 19.44 0 0 1 740.4 337.76A242.99 242.99 0 0 1 716.43 552.04L526.31 847.95Z' }),
    svg('path', { fill: '#F97316', d: 'M559.79 281.35A8.5 8.5 0 0 1 567.67 284.54L621.22 353.08A8.5 8.5 0 0 1 622.41 361.5L589.82 442.15A8.5 8.5 0 0 1 583.12 447.38L496.99 459.49A8.5 8.5 0 0 1 489.1 456.3L435.55 387.76A8.5 8.5 0 0 1 434.37 379.34L466.95 298.69A8.5 8.5 0 0 1 473.65 293.46L559.79 281.35Z' }),
  );
}
