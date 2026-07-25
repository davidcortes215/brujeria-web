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

  /* --- Formulario de contacto: envío AJAX fiable -----------------------
     El mensaje de éxito SOLO se muestra si el servidor confirma que ha
     aceptado la solicitud. Si falla, el visitante ve un error claro y una
     vía alternativa — nunca un falso "enviado". Sin JS, el form hace un
     POST normal (con redirect) y también funciona. */
  var form = document.getElementById('contact-form');
  if (form && window.fetch) {
    var statusEl = document.getElementById('form-status');
    var btn = form.querySelector('.submit-btn');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }

      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Enviando…';
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'form-status'; }

      fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        body: new FormData(form)
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.success) {
            // Éxito CONFIRMADO por el servidor → página de gracias
            window.location.href = 'gracias.html';
          } else {
            throw new Error((data && data.message) || 'respuesta no válida');
          }
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = originalText;
          if (statusEl) {
            statusEl.textContent = 'No se pudo enviar. Revisa tu conexión e inténtalo de nuevo, o escríbenos directamente a hola@brujeria.pro.';
            statusEl.className = 'form-status form-status--error';
          }
        });
    });
  }
})();
