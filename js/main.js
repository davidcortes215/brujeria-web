/* BrujerIA — mejoras progresivas.
   Sin JS la página es completamente funcional y visible. */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- Revelado sutil al entrar en el viewport -------------------------
     El escalonado se calcula por sección, para que cada bloque
     aparezca en su orden natural de lectura. */
  if (!reduceMotion && 'IntersectionObserver' in window) {
    var groups = document.querySelectorAll('main section, footer');
    groups.forEach(function (group) {
      var items = group.querySelectorAll('[data-reveal]');
      items.forEach(function (el, i) {
        el.classList.add('reveal');
        el.style.transitionDelay = Math.min(i, 4) * 70 + 'ms';
      });
    });

    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });

    document.querySelectorAll('[data-reveal]').forEach(function (el) {
      revealObserver.observe(el);
    });
  }

  /* --- Sección activa en la navegación ---------------------------------
     Se observan TODAS las secciones: al pasar por una sin enlace
     (p. ej. Propósito) la navegación no deja nada marcado. */
  var navLinks = document.querySelectorAll('.site-header nav a');
  if (navLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    navLinks.forEach(function (a) {
      var id = (a.getAttribute('href') || '').slice(1);
      if (id) byId[id] = a;
    });

    var sectionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        navLinks.forEach(function (a) { a.removeAttribute('aria-current'); });
        var link = byId[entry.target.id];
        if (link) link.setAttribute('aria-current', 'location');
      });
    }, { rootMargin: '-35% 0px -55% 0px' });

    document.querySelectorAll('main section[id]').forEach(function (section) {
      sectionObserver.observe(section);
    });
  }

  /* --- Formulario de contacto: envío AJAX por DOBLE canal --------------
     Cada solicitud se envía a la vez por dos vías INDEPENDIENTES:
       · Canal 1: Web3Forms  -> hola@brujeria.pro (Zoho)
       · Canal 2: FormSubmit -> davidcortes215@gmail.com (Gmail)
     Servicios y buzones distintos: si uno falla, el otro entrega igual.
     El mensaje de éxito SOLO se muestra si AL MENOS un canal confirma la
     recepción. Si fallan los dos, el visitante ve un error claro y una vía
     alternativa — nunca un falso "enviado". Sin JS, el form hace un POST
     normal a Web3Forms (con redirect) y también funciona. */
  var form = document.getElementById('contact-form');
  if (form && window.fetch) {
    var statusEl = document.getElementById('form-status');
    var btn = form.querySelector('.submit-btn');
    var GMAIL_ENDPOINT = 'https://formsubmit.co/ajax/3276e5d88b62ff8e478762c92c5d5f66';

    var showError = function (originalText) {
      btn.disabled = false;
      btn.textContent = originalText;
      if (statusEl) {
        statusEl.textContent = 'No se pudo enviar. Revisa tu conexión e inténtalo de nuevo, o escríbenos directamente a hola@brujeria.pro.';
        statusEl.className = 'form-status form-status--error';
      }
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }

      // honeypot antispam: si un bot marcó la casilla oculta, no enviamos
      var honey = form.querySelector('[name="botcheck"]');
      if (honey && honey.checked) { window.location.href = 'gracias.html'; return; }

      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Enviando…';
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'form-status'; }

      var get = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value : ''; };

      // Canal 1: Web3Forms -> Zoho (FormData completo del formulario)
      var toZoho = fetch('https://api.web3forms.com/submit', { method: 'POST', body: new FormData(form) })
        .then(function (r) { return r.json(); })
        .then(function (d) { return !!(d && d.success); })
        .catch(function () { return false; });

      // Canal 2: FormSubmit -> Gmail (servicio y buzón independientes)
      var fd2 = new FormData();
      fd2.append('email', get('email'));
      fd2.append('Empresa', get('Empresa'));
      fd2.append('Proceso', get('Proceso'));
      fd2.append('Consentimiento', 'Política de privacidad aceptada');
      fd2.append('_subject', 'Nuevo contacto desde la web de BrujerIA');
      fd2.append('_template', 'table');
      fd2.append('_captcha', 'false');
      var toGmail = fetch(GMAIL_ENDPOINT, { method: 'POST', headers: { 'Accept': 'application/json' }, body: fd2 })
        .then(function (r) { return r.json(); })
        .then(function (d) { return !!(d && (d.success === 'true' || d.success === true)); })
        .catch(function () { return false; });

      Promise.all([toZoho, toGmail]).then(function (res) {
        if (res[0] || res[1]) {
          // al menos un canal confirmó la recepción
          window.location.href = 'gracias.html';
        } else {
          showError(originalText);
        }
      });
    });
  }
})();
