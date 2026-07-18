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
})();
