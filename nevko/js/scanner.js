// Barcode / QR scanner overlay using the native BarcodeDetector API (Chrome on Android).
// Only offered when the API exists and the page is a secure context (HTTPS or localhost),
// because camera access requires it.
//
//   if (canScan()) { const code = await scanCode(); if (code) ... }

import { isDemo } from './demo.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { captureBack, toast, vibrate } from './ui.js';

const PREFERRED_FORMATS = [
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'ean_13',
  'ean_8',
  'itf',
  'upc_a',
  'upc_e',
  'qr_code',
  'data_matrix',
  'pdf417',
  'aztec',
];
const DETECT_INTERVAL_MS = 120;

/** True when this device/browser can scan codes with the camera. */
export function canScan() {
  return (
    !isDemo() && // the demo page cannot use the camera
    'BarcodeDetector' in window &&
    window.isSecureContext === true &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'No hay permiso para usar la cámara. Actívalo en los ajustes del navegador.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No se ha encontrado ninguna cámara en este dispositivo.';
    case 'NotReadableError':
    case 'AbortError':
      return 'La cámara está ocupada por otra aplicación.';
    default:
      return 'No se ha podido abrir la cámara.';
  }
}

async function createDetector() {
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = PREFERRED_FORMATS.filter((format) => supported.includes(format));
    if (!formats.length) return null;
    return new window.BarcodeDetector({ formats });
  } catch {
    try {
      return new window.BarcodeDetector();
    } catch {
      return null;
    }
  }
}

/**
 * Opens the full-screen camera overlay. Resolves with the decoded text of the first
 * code found, or null when the user closes it (X, Esc, back button) or on error.
 */
export async function scanCode() {
  if (!canScan()) return null;
  const detector = await createDetector();
  if (!detector) {
    toast('Este dispositivo no puede leer códigos de barras.', { type: 'warning' });
    return null;
  }

  return new Promise((resolve) => {
    const opener = document.activeElement;
    const app = document.getElementById('app');
    let stream = null;
    let track = null;
    let torchOn = false;
    let finished = false;
    let timer = null;

    const video = h('video.scanner-video', { autoplay: true, muted: true, playsinline: true, 'aria-hidden': 'true' });
    video.muted = true;
    video.playsInline = true;

    const torchButton = h(
      'button.btn.scanner-btn',
      { type: 'button', 'aria-label': 'Linterna', 'aria-pressed': 'false', hidden: true, onClick: toggleTorch },
      icon('flashlight', { size: 22 }),
    );
    const closeButton = h(
      'button.btn.scanner-btn',
      { type: 'button', 'aria-label': 'Cerrar escáner', onClick: () => finish(null) },
      icon('x', { size: 22 }),
    );
    const overlay = h(
      'div.scanner',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Escanear código' },
      video,
      h('div.scanner-frame', { 'aria-hidden': 'true' }),
      h('div.scanner-bar', closeButton, h('div.scanner-title', 'Escanear código'), torchButton),
      h('p.scanner-hint', 'Apunta la cámara al código de barras o QR del útil.'),
    );

    const back = captureBack(() => finish(null, { viaBack: true }));
    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      } else if (event.key === 'Tab') {
        // Keep focus inside the overlay.
        const items = [closeButton, torchButton].filter((b) => !b.hidden);
        const i = items.indexOf(document.activeElement);
        event.preventDefault();
        items[(i + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    };

    document.body.append(overlay);
    document.body.classList.add('is-scroll-locked');
    app?.setAttribute('inert', '');
    document.addEventListener('keydown', onKeydown, true);
    closeButton.focus();

    async function toggleTorch() {
      if (!track) return;
      try {
        torchOn = !torchOn;
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        torchButton.setAttribute('aria-pressed', String(torchOn));
      } catch {
        torchOn = false;
        torchButton.hidden = true;
      }
    }

    async function detectLoop() {
      if (finished) return;
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video);
          const value = codes.map((code) => (code.rawValue ?? '').trim()).find(Boolean);
          if (value && !finished) {
            overlay.classList.add('is-detected');
            vibrate(60);
            setTimeout(() => finish(value), 150);
            return;
          }
        }
      } catch {
        // Frame not ready or transient detector error: try again on the next frame.
      }
      timer = setTimeout(detectLoop, DETECT_INTERVAL_MS);
    }

    function finish(value, { viaBack = false } = {}) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (!document.querySelector('.layer')) {
        document.body.classList.remove('is-scroll-locked');
        app?.removeAttribute('inert');
      }
      const released = viaBack ? Promise.resolve() : back.release();
      released.then(() => {
        if (opener?.isConnected && value === null) opener.focus();
        resolve(value);
      });
    }

    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      .then(async (mediaStream) => {
        if (finished) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = mediaStream;
        track = stream.getVideoTracks()[0] ?? null;
        video.srcObject = stream;
        await video.play().catch(() => {});
        try {
          if (track?.getCapabilities?.().torch) torchButton.hidden = false;
        } catch {
          // Capabilities not available.
        }
        detectLoop();
      })
      .catch((err) => {
        toast(cameraErrorMessage(err), { type: 'error' });
        finish(null);
      });
  });
}
