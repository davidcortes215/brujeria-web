/* ==========================================================================
   BrujerIA — Mi Mapa
   Puntos de interés personales sobre España. Sin backend: los datos viven
   en localStorage. Exportar / importar para copia de seguridad o cambio de
   dispositivo. Mapa: Leaflet + teselas de OpenStreetMap.
   ========================================================================== */
(function () {
  "use strict";

  // --- Categorías ---------------------------------------------------------
  var CATEGORIES = [
    { id: "restaurante", label: "Restaurante", emoji: "🍽️", color: "#C1440E" },
    { id: "bar",         label: "Bar / Café",  emoji: "☕",  color: "#8D6E63" },
    { id: "mirador",     label: "Mirador",     emoji: "🌄", color: "#2E7D32" },
    { id: "faro",        label: "Faro",        emoji: "🗼", color: "#1565C0" },
    { id: "playa",       label: "Playa",       emoji: "🏖️", color: "#00ACC1" },
    { id: "acampada",    label: "Acampada",    emoji: "⛺", color: "#33691E" },
    { id: "ruta",        label: "Ruta",        emoji: "🥾", color: "#F9A825" },
    { id: "pueblo",      label: "Pueblo",      emoji: "🏘️", color: "#8E24AA" },
    { id: "alojamiento", label: "Alojamiento", emoji: "🛏️", color: "#5E35B1" },
    { id: "monumento",   label: "Monumento",   emoji: "🏛️", color: "#546E7A" },
    { id: "naturaleza",  label: "Naturaleza",  emoji: "🌲", color: "#1B5E20" },
    { id: "otro",        label: "Otro",        emoji: "📍", color: "#616161" }
  ];
  var CAT_BY_ID = {};
  CATEGORIES.forEach(function (c) { CAT_BY_ID[c.id] = c; });
  function cat(id) { return CAT_BY_ID[id] || CAT_BY_ID.otro; }

  var STORAGE_KEY = "brujeria-mapa-puntos-v1";

  // --- Estado -------------------------------------------------------------
  var points = [];
  var map, markersLayer;
  var markerById = {};       // id -> L.marker
  var addMode = false;
  var editingId = null;      // id del punto en edición (null = nuevo)
  var draft = null;          // { lat, lng } del punto nuevo
  var draftStars = 0;
  var draftStatus = "visitado";

  var filters = {
    text: "",
    cats: {},                // id -> bool (todas true por defecto)
    rating: 0,
    status: "todos"
  };
  CATEGORIES.forEach(function (c) { filters.cats[c.id] = true; });

  // --- Utilidades de almacenamiento --------------------------------------
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      points = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(points)) points = [];
    } catch (e) { points = []; }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(points));
    } catch (e) {
      toast("No se pudo guardar (almacenamiento lleno o bloqueado).");
    }
  }
  function uid() {
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // --- Helpers DOM --------------------------------------------------------
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function starsText(n) {
    n = n || 0;
    return "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var toastTimer;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // --- Icono del marcador -------------------------------------------------
  function makeIcon(p) {
    var c = cat(p.cat);
    var pending = p.status === "pendiente" ? " is-pending" : "";
    return L.divIcon({
      className: "",
      html: '<div class="poi-pin' + pending + '" style="background:' + c.color + '">' +
            '<span>' + c.emoji + '</span></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 28],
      popupAnchor: [0, -26]
    });
  }

  // --- Mapa ---------------------------------------------------------------
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true })
      .setView([40.0, -3.7], 6); // España completa por defecto

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);

    map.on("click", function (e) {
      if (addMode) {
        openEditor(null, e.latlng.lat, e.latlng.lng);
        setAddMode(false);
      }
    });

    // Intentar centrar en la ubicación actual al abrir
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        // Solo re-centramos si no hay muchos puntos guardados que ver
        map.setView([pos.coords.latitude, pos.coords.longitude], 13, { animate: true });
      }, function () { /* permiso denegado: nos quedamos en España */ },
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 });
    }
  }

  // --- Render de marcadores ----------------------------------------------
  function renderMarkers() {
    markersLayer.clearLayers();
    markerById = {};
    var visible = filteredPoints();
    visible.forEach(function (p) {
      var m = L.marker([p.lat, p.lng], { icon: makeIcon(p), title: p.name });
      m.bindPopup(popupHtml(p), { closeButton: true });
      m.on("popupopen", function () { wirePopup(p.id); highlightCard(p.id); });
      m.addTo(markersLayer);
      markerById[p.id] = m;
    });
  }

  function popupHtml(p) {
    var c = cat(p.cat);
    var meta = c.label + (p.status === "pendiente" ? " · pendiente" : "");
    var stars = p.status === "pendiente" && !p.stars
      ? "" : '<span class="popup-stars">' + starsText(p.stars) + "</span> ";
    var notes = p.notes
      ? '<div class="popup-notes">' + escapeHtml(p.notes) + "</div>" : "";
    return '<div class="popup" data-id="' + p.id + '">' +
      '<div class="popup-name">' + escapeHtml(p.name) + "</div>" +
      '<div class="popup-meta">' + stars + escapeHtml(meta) + "</div>" +
      notes +
      '<div class="popup-actions">' +
        '<button type="button" data-act="edit">Editar</button>' +
        '<button type="button" data-act="delete">Eliminar</button>' +
      "</div></div>";
  }

  function wirePopup(id) {
    var node = document.querySelector('.popup[data-id="' + id + '"]');
    if (!node) return;
    node.querySelector('[data-act="edit"]').onclick = function () {
      map.closePopup();
      var p = pointById(id);
      if (p) openEditor(p.id, p.lat, p.lng);
    };
    node.querySelector('[data-act="delete"]').onclick = function () {
      if (confirm("¿Eliminar este punto?")) { deletePoint(id); }
    };
  }

  // --- Filtro -------------------------------------------------------------
  function filteredPoints() {
    var txt = filters.text.trim().toLowerCase();
    return points.filter(function (p) {
      if (!filters.cats[p.cat]) return false;
      if (filters.rating > 0 && (p.stars || 0) < filters.rating) return false;
      if (filters.status !== "todos" && p.status !== filters.status) return false;
      if (txt) {
        var hay = (p.name + " " + (p.notes || "") + " " + cat(p.cat).label).toLowerCase();
        if (hay.indexOf(txt) === -1) return false;
      }
      return true;
    });
  }

  function filtersActive() {
    if (filters.text || filters.rating > 0 || filters.status !== "todos") return true;
    return CATEGORIES.some(function (c) { return !filters.cats[c.id]; });
  }

  // --- Render de la lista -------------------------------------------------
  function renderList() {
    var ul = $("#poi-list");
    ul.innerHTML = "";
    var visible = filteredPoints().sort(function (a, b) {
      return (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name);
    });

    $("#count-visible").textContent = visible.length;
    $("#count-total").textContent = points.length;
    $("#btn-reset-filters").hidden = !filtersActive();

    if (points.length === 0) {
      ul.appendChild(emptyState(
        "Aún no tienes puntos.",
        "Pulsa “Añadir” y toca el mapa para guardar tu primer sitio."));
      return;
    }
    if (visible.length === 0) {
      ul.appendChild(emptyState(
        "Ningún punto coincide con los filtros.", ""));
      return;
    }

    visible.forEach(function (p) {
      var c = cat(p.cat);
      var li = el("li", "poi-card");
      li.dataset.id = p.id;

      var top = el("div", "poi-card-top");
      var icon = el("span", "poi-card-icon");
      icon.style.background = c.color;
      icon.textContent = c.emoji;
      top.appendChild(icon);
      top.appendChild(el("span", "poi-card-name", p.name));
      li.appendChild(top);

      var meta = el("div", "poi-card-meta");
      if (p.status === "pendiente" && !p.stars) {
        meta.appendChild(el("span", "poi-card-pend", "Pendiente"));
      } else {
        meta.appendChild(el("span", "poi-card-stars", starsText(p.stars)));
      }
      meta.appendChild(el("span", "poi-card-cat", c.label));
      li.appendChild(meta);

      if (p.notes) li.appendChild(el("div", "poi-card-notes", p.notes));

      li.addEventListener("click", function () { focusPoint(p.id); });
      ul.appendChild(li);
    });
  }

  function emptyState(title, sub) {
    var d = el("div", "poi-empty");
    d.appendChild(el("div", null, title));
    if (sub) { var s = el("div", null, sub); s.style.marginTop = "0.4rem"; d.appendChild(s); }
    var li = el("li");
    li.appendChild(d);
    return li;
  }

  function highlightCard(id) {
    document.querySelectorAll(".poi-card").forEach(function (c) {
      c.classList.toggle("is-active", c.dataset.id === id);
    });
  }

  function focusPoint(id) {
    var p = pointById(id);
    if (!p) return;
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14), { animate: true });
    var m = markerById[id];
    if (m) m.openPopup();
    highlightCard(id);
    if (window.innerWidth <= 720) setPanelHidden(true);
  }

  // --- CRUD ---------------------------------------------------------------
  function pointById(id) {
    for (var i = 0; i < points.length; i++) if (points[i].id === id) return points[i];
    return null;
  }
  function deletePoint(id) {
    points = points.filter(function (p) { return p.id !== id; });
    save();
    renderMarkers();
    renderList();
    toast("Punto eliminado.");
  }

  // --- Editor -------------------------------------------------------------
  function buildStarInput() {
    var box = $("#poi-stars");
    box.innerHTML = "";
    for (var i = 1; i <= 5; i++) {
      (function (val) {
        var b = el("button", "star", "★");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-label", val + " estrella" + (val > 1 ? "s" : ""));
        b.addEventListener("click", function () { setStars(val); });
        box.appendChild(b);
      })(i);
    }
  }
  function setStars(n) {
    draftStars = (draftStars === n) ? n - 1 : n; // volver a pulsar la misma baja una
    if (draftStars < 0) draftStars = 0;
    var kids = $("#poi-stars").children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle("is-on", i < draftStars);
      kids[i].setAttribute("aria-checked", (i + 1) === draftStars ? "true" : "false");
    }
  }
  function setStatus(s) {
    draftStatus = s;
    document.querySelectorAll("#poi-status .toggle").forEach(function (t) {
      t.setAttribute("aria-checked", t.dataset.status === s ? "true" : "false");
    });
  }

  function openEditor(id, lat, lng) {
    editingId = id;
    var p = id ? pointById(id) : null;

    $("#editor-title").textContent = p ? "Editar punto" : "Nuevo punto";
    $("#poi-name").value = p ? p.name : "";
    $("#poi-cat").value = p ? p.cat : "restaurante";
    $("#poi-notes").value = p ? (p.notes || "") : "";
    setStars(0); draftStars = 0;
    if (p) setStars(p.stars || 0);
    setStatus(p ? (p.status || "visitado") : "visitado");

    draft = { lat: lat, lng: lng };
    $("#poi-coords").textContent = "📍 " + lat.toFixed(5) + ", " + lng.toFixed(5);
    $("#poi-delete").hidden = !p;

    $("#editor-backdrop").hidden = false;
    $("#editor").hidden = false;
    setTimeout(function () { $("#poi-name").focus(); }, 30);
  }

  function closeEditor() {
    $("#editor").hidden = true;
    $("#editor-backdrop").hidden = true;
    editingId = null;
    draft = null;
  }

  function submitEditor(e) {
    e.preventDefault();
    var name = $("#poi-name").value.trim();
    if (!name) { $("#poi-name").focus(); return; }
    var data = {
      name: name,
      cat: $("#poi-cat").value,
      stars: draftStars,
      status: draftStatus,
      notes: $("#poi-notes").value.trim()
    };
    if (editingId) {
      var p = pointById(editingId);
      if (p) { Object.assign(p, data); }
    } else {
      points.push(Object.assign({
        id: uid(), lat: draft.lat, lng: draft.lng, created: Date.now()
      }, data));
    }
    save();
    renderMarkers();
    renderList();
    var savedId = editingId;
    closeEditor();
    toast(savedId ? "Punto actualizado." : "Punto guardado.");
  }

  // --- Modo añadir --------------------------------------------------------
  function setAddMode(on) {
    addMode = on;
    document.querySelector(".app").classList.toggle("adding", on);
    $("#btn-add").setAttribute("aria-pressed", on ? "true" : "false");
    $("#map-hint").hidden = !on;
    if (on && window.innerWidth <= 720) setPanelHidden(true);
  }

  // --- Panel --------------------------------------------------------------
  function setPanelHidden(hidden) {
    $("#panel").classList.toggle("is-hidden", hidden);
    setTimeout(function () { map.invalidateSize(); }, 260);
  }
  function togglePanel() {
    setPanelHidden(!$("#panel").classList.contains("is-hidden"));
  }

  // --- Filtros UI ---------------------------------------------------------
  function buildCategoryUI() {
    // chips de filtro
    var box = $("#filter-cats");
    CATEGORIES.forEach(function (c) {
      var b = el("button", "chip");
      b.type = "button";
      b.dataset.cat = c.id;
      b.setAttribute("aria-pressed", "true");
      var dot = el("span", "chip-dot");
      dot.style.background = c.color;
      b.appendChild(dot);
      b.appendChild(el("span", null, c.label));
      b.addEventListener("click", function () {
        filters.cats[c.id] = !filters.cats[c.id];
        b.setAttribute("aria-pressed", filters.cats[c.id] ? "true" : "false");
        refresh();
      });
      box.appendChild(b);
    });
    // select del editor
    var sel = $("#poi-cat");
    CATEGORIES.forEach(function (c) {
      var o = el("option", null, c.emoji + "  " + c.label);
      o.value = c.id;
      sel.appendChild(o);
    });
  }

  function refresh() { renderMarkers(); renderList(); }

  function resetFilters() {
    filters.text = "";
    filters.rating = 0;
    filters.status = "todos";
    CATEGORIES.forEach(function (c) { filters.cats[c.id] = true; });
    $("#filter-text").value = "";
    $("#filter-rating").value = "0";
    $("#filter-status").value = "todos";
    document.querySelectorAll("#filter-cats .chip").forEach(function (b) {
      b.setAttribute("aria-pressed", "true");
    });
    refresh();
  }

  // --- Exportar / importar ------------------------------------------------
  function exportData() {
    if (points.length === 0) { toast("No hay puntos que exportar."); return; }
    var blob = new Blob([JSON.stringify(points, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var d = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "mi-mapa-brujeria-" + d + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Exportados " + points.length + " puntos.");
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = JSON.parse(reader.result);
        if (!Array.isArray(incoming)) throw new Error("formato");
        var existing = {};
        points.forEach(function (p) { existing[p.id] = true; });
        var added = 0;
        incoming.forEach(function (p) {
          if (p && typeof p.lat === "number" && typeof p.lng === "number" && p.name) {
            if (!p.id || existing[p.id]) p.id = uid();
            if (!p.cat || !CAT_BY_ID[p.cat]) p.cat = "otro";
            if (!p.status) p.status = "visitado";
            p.stars = Math.max(0, Math.min(5, p.stars || 0));
            points.push(p);
            existing[p.id] = true;
            added++;
          }
        });
        save();
        refresh();
        toast("Importados " + added + " puntos.");
      } catch (e) {
        toast("Archivo no válido.");
      }
    };
    reader.readAsText(file);
  }

  // --- Buscar lugar (geocodificación con Nominatim) -----------------------
  var geoTimer, geoActiveIndex = -1, geoItems = [];
  function geosearch(q) {
    var url = "https://nominatim.openstreetmap.org/search?format=json&limit=6" +
      "&countrycodes=es&accept-language=es&q=" + encodeURIComponent(q);
    fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (data) { showGeoResults(data || []); })
      .catch(function () { showGeoResults([]); });
  }
  function showGeoResults(list) {
    var ul = $("#geosearch-results");
    ul.innerHTML = "";
    geoItems = list;
    geoActiveIndex = -1;
    if (!list.length) {
      var li = el("li", "empty", "Sin resultados");
      ul.appendChild(li);
      ul.hidden = false;
      return;
    }
    list.forEach(function (item, i) {
      var li = el("li", null, item.display_name);
      li.addEventListener("click", function () { pickGeo(i); });
      ul.appendChild(li);
    });
    ul.hidden = false;
  }
  function pickGeo(i) {
    var item = geoItems[i];
    if (!item) return;
    map.setView([parseFloat(item.lat), parseFloat(item.lon)], 15, { animate: true });
    $("#geosearch-results").hidden = true;
    $("#geosearch-input").value = "";
    toast("¿Buen sitio? Pulsa “Añadir” para guardarlo.");
  }

  // --- Cableado de eventos -------------------------------------------------
  function wireEvents() {
    $("#btn-add").addEventListener("click", function () { setAddMode(!addMode); });
    $("#btn-cancel-add").addEventListener("click", function () { setAddMode(false); });
    $("#btn-panel").addEventListener("click", togglePanel);

    $("#btn-locate").addEventListener("click", function () {
      if (!navigator.geolocation) { toast("Geolocalización no disponible."); return; }
      toast("Buscando tu ubicación…");
      navigator.geolocation.getCurrentPosition(function (pos) {
        map.setView([pos.coords.latitude, pos.coords.longitude], 14, { animate: true });
      }, function () { toast("No se pudo obtener tu ubicación."); },
      { enableHighAccuracy: true, timeout: 8000 });
    });

    // Editor
    $("#editor-form").addEventListener("submit", submitEditor);
    $("#editor-close").addEventListener("click", closeEditor);
    $("#poi-cancel").addEventListener("click", closeEditor);
    $("#editor-backdrop").addEventListener("click", closeEditor);
    $("#poi-delete").addEventListener("click", function () {
      if (editingId && confirm("¿Eliminar este punto?")) { deletePoint(editingId); closeEditor(); }
    });
    document.querySelectorAll("#poi-status .toggle").forEach(function (t) {
      t.addEventListener("click", function () { setStatus(t.dataset.status); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!$("#editor").hidden) closeEditor();
        else if (addMode) setAddMode(false);
      }
    });

    // Filtros
    $("#filter-text").addEventListener("input", function () {
      filters.text = this.value; refresh();
    });
    $("#filter-rating").addEventListener("change", function () {
      filters.rating = parseInt(this.value, 10) || 0; refresh();
    });
    $("#filter-status").addEventListener("change", function () {
      filters.status = this.value; refresh();
    });
    $("#btn-reset-filters").addEventListener("click", resetFilters);
    $("#cats-toggle-all").addEventListener("click", function () {
      var anyOff = CATEGORIES.some(function (c) { return !filters.cats[c.id]; });
      CATEGORIES.forEach(function (c) { filters.cats[c.id] = anyOff; });
      document.querySelectorAll("#filter-cats .chip").forEach(function (b) {
        b.setAttribute("aria-pressed", anyOff ? "true" : "false");
      });
      refresh();
    });

    // Exportar / importar
    $("#btn-export").addEventListener("click", exportData);
    $("#btn-import").addEventListener("click", function () { $("#import-file").click(); });
    $("#import-file").addEventListener("change", function () {
      if (this.files && this.files[0]) importData(this.files[0]);
      this.value = "";
    });

    // Buscador de lugares
    var input = $("#geosearch-input");
    input.addEventListener("input", function () {
      var q = this.value.trim();
      clearTimeout(geoTimer);
      if (q.length < 3) { $("#geosearch-results").hidden = true; return; }
      geoTimer = setTimeout(function () { geosearch(q); }, 350);
    });
    input.addEventListener("keydown", function (e) {
      var ul = $("#geosearch-results");
      if (ul.hidden) return;
      var items = ul.querySelectorAll("li:not(.empty)");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        geoActiveIndex = Math.min(geoActiveIndex + 1, items.length - 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        geoActiveIndex = Math.max(geoActiveIndex - 1, 0);
      } else if (e.key === "Enter") {
        e.preventDefault();
        pickGeo(geoActiveIndex >= 0 ? geoActiveIndex : 0);
        return;
      } else { return; }
      items.forEach(function (li, i) { li.classList.toggle("active", i === geoActiveIndex); });
    });
    document.addEventListener("click", function (e) {
      if (!$("#geosearch").contains(e.target)) $("#geosearch-results").hidden = true;
    });
    $("#geosearch").addEventListener("submit", function (e) { e.preventDefault(); });
  }

  // --- Arranque -----------------------------------------------------------
  function init() {
    load();
    initMap();
    buildCategoryUI();
    buildStarInput();
    wireEvents();
    refresh();
    // En escritorio el panel arranca visible; en móvil, oculto para ver el mapa.
    if (window.innerWidth <= 720) $("#panel").classList.add("is-hidden");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
