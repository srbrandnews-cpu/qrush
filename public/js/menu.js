/* ==========================================================================
   QRush — Customer mobile menu (Phase 1)
   Language switch · category chips · live search · photo gallery · lightbox.
   Vanilla JS, no framework, no network calls after load.
   ========================================================================== */
(function () {
  'use strict';

  var DATA = { items: [], photos: [], pdf: '', hours: { open: '', close: '' } };
  var dataNode = document.getElementById('qm-data');
  if (dataNode) {
    try { DATA = JSON.parse(dataNode.textContent || '{}') || DATA; } catch (e) { /* keep defaults */ }
  }
  DATA.items = Array.isArray(DATA.items) ? DATA.items : [];
  DATA.photos = Array.isArray(DATA.photos) ? DATA.photos : [];

  /* ---------- translations ------------------------------------------------ */
  var T = {
    en: {
      digitalMenu: 'Digital menu',
      by: 'By',
      search: 'Search dishes',
      clear: 'Clear search',
      all: 'All',
      items: 'items',
      item: 'item',
      menuCardPhotos: 'Menu card photos',
      page: 'Page',
      connect: 'Connect with us',
      openNow: 'Open now',
      closedNow: 'Closed',
      call: 'Call us',
      noResults: 'No dishes found',
      noResultsHint: 'Try another dish name or pick a different category.',
      photoOnlyTitle: 'Menu card inside.',
      photoOnlyHint: 'This restaurant uploaded a menu card — tap a photo to zoom.',
      pdfOnlyTitle: 'Full menu PDF.',
      pdfOnlyHint: 'Tap the button below to open the menu card as a PDF.',
      viewPdf: 'View full menu (PDF)',
      close: 'Close',
      menuPhotoAlt: 'Menu card photo',
      results: 'results'
    },
    hi: {
      digitalMenu: 'डिजिटल मेनू',
      by: 'द्वारा',
      search: 'व्यंजन खोजें',
      clear: 'खोज साफ़ करें',
      all: 'सभी',
      items: 'आइटम',
      item: 'आइटम',
      menuCardPhotos: 'मेनू कार्ड की फ़ोटो',
      page: 'पेज',
      connect: 'हमसे जुड़ें',
      openNow: 'अभी खुला है',
      closedNow: 'अभी बंद है',
      call: 'कॉल करें',
      noResults: 'कोई व्यंजन नहीं मिला',
      noResultsHint: 'दूसरा नाम खोजें या दूसरी श्रेणी चुनें।',
      photoOnlyTitle: 'मेनू कार्ड अंदर है।',
      photoOnlyHint: 'इस रेस्टोरेंट ने मेनू कार्ड अपलोड किया है — बड़ा करने के लिए फ़ोटो पर टैप करें।',
      pdfOnlyTitle: 'पूरा मेनू PDF में।',
      pdfOnlyHint: 'मेनू कार्ड PDF में खोलने के लिए नीचे वाला बटन दबाएँ।',
      viewPdf: 'पूरा मेनू देखें (PDF)',
      close: 'बंद करें',
      menuPhotoAlt: 'मेनू कार्ड फ़ोटो',
      results: 'परिणाम'
    },
    mr: {
      digitalMenu: 'डिजिटल मेनू',
      by: 'यांनी',
      search: 'पदार्थ शोधा',
      clear: 'शोध साफ करा',
      all: 'सर्व',
      items: 'आयटम',
      item: 'आयटम',
      menuCardPhotos: 'मेनू कार्डचे फोटो',
      page: 'पृष्ठ',
      connect: 'आमच्याशी संपर्क साधा',
      openNow: 'आता सुरू आहे',
      closedNow: 'आता बंद आहे',
      call: 'कॉल करा',
      noResults: 'कोणताही पदार्थ सापडला नाही',
      noResultsHint: 'दुसरे नाव शोधा किंवा दुसरी श्रेणी निवडा.',
      photoOnlyTitle: 'मेनू कार्ड आत आहे.',
      photoOnlyHint: 'या रेस्टॉरंटने मेनू कार्ड अपलोड केले आहे — मोठे करण्यासाठी फोटोवर टॅप करा.',
      pdfOnlyTitle: 'पूर्ण मेनू PDF मध्ये.',
      pdfOnlyHint: 'मेनू कार्ड PDF मध्ये उघडण्यासाठी खालील बटण दाबा.',
      viewPdf: 'पूर्ण मेनू पहा (PDF)',
      close: 'बंद करा',
      menuPhotoAlt: 'मेनू कार्ड फोटो',
      results: 'निकाल'
    }
  };

  var state = { lang: 'en', q: '', cat: '' };

  var els = {
    tools: document.getElementById('qm-tools'),
    q: document.getElementById('qm-q'),
    clear: document.getElementById('qm-clear'),
    chips: document.getElementById('qm-chips'),
    list: document.getElementById('qm-list'),
    empty: document.getElementById('qm-empty'),
    status: document.getElementById('qm-status'),
    gallery: document.getElementById('qm-gallery'),
    thumbs: document.getElementById('qm-thumbs'),
    lb: document.getElementById('qm-lightbox'),
    lbImg: document.getElementById('qm-lb-img'),
    lbCount: document.getElementById('qm-lb-count'),
    lbClose: document.getElementById('qm-lb-close')
  };

  function t(key) {
    var table = T[state.lang] || T.en;
    return table[key] || T.en[key] || key;
  }

  function money(value) {
    var v = Number(value) || 0;
    try {
      return '\u20B9' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    } catch (e) {
      return '\u20B9' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
    }
  }

  /* ---------- language ---------------------------------------------------- */
  function applyLang(lang, save) {
    state.lang = T[lang] ? lang : 'en';
    document.documentElement.lang = state.lang;
    document.documentElement.setAttribute('data-lang', state.lang);

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var text = t(el.getAttribute('data-i18n'));
      if (text) el.textContent = text;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    document.querySelectorAll('.qm-langs button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-lang') === state.lang ? 'true' : 'false');
    });

    buildChips();
    render();
    renderStatus();
    if (save) {
      try { localStorage.setItem('qrush.lang', state.lang); } catch (e) { /* private mode */ }
    }
  }

  function preferredLang() {
    var fromUrl = '';
    try {
      fromUrl = (new URLSearchParams(window.location.search).get('lang') || '').toLowerCase();
    } catch (e) { /* old browser */ }
    if (T[fromUrl]) return fromUrl;
    var saved = '';
    try { saved = localStorage.getItem('qrush.lang') || ''; } catch (e) { /* ignore */ }
    if (T[saved]) return saved;
    var nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
    if (nav.indexOf('mr') === 0) return 'mr';
    if (nav.indexOf('hi') === 0) return 'hi';
    return 'en';
  }

  document.querySelectorAll('.qm-langs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      applyLang(btn.getAttribute('data-lang'), true);
    });
  });

  /* ---------- categories -------------------------------------------------- */
  function categories() {
    var out = [];
    DATA.items.forEach(function (it) {
      var c = String(it.c || '').trim();
      if (c && out.indexOf(c) === -1) out.push(c);
    });
    return out;
  }

  function buildChips() {
    if (!els.chips) return;
    var cats = categories();
    els.chips.innerHTML = '';
    if (!cats.length) {
      els.chips.hidden = true;
      return;
    }
    els.chips.hidden = false;
    if (state.cat && cats.indexOf(state.cat) === -1) state.cat = '';
    els.chips.appendChild(makeChip('', t('all')));
    cats.forEach(function (cat) { els.chips.appendChild(makeChip(cat, cat)); });
  }

  function makeChip(value, label) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qm-chip';
    btn.textContent = label;
    btn.setAttribute('aria-pressed', state.cat === value ? 'true' : 'false');
    btn.addEventListener('click', function () {
      state.cat = value;
      els.chips.querySelectorAll('.qm-chip').forEach(function (c) {
        c.setAttribute('aria-pressed', c === btn ? 'true' : 'false');
      });
      render();
    });
    return btn;
  }

  /* ---------- item cards -------------------------------------------------- */
  function makeCard(item, eager) {
    var card = document.createElement('article');
    card.className = 'qm-card';

    var photo = document.createElement('div');
    photo.className = 'qm-photo';
    if (item.img) {
      var img = document.createElement('img');
      img.src = item.img;
      img.alt = item.n || '';
      img.loading = eager ? 'eager' : 'lazy';
      img.decoding = 'async';
      if (eager) img.setAttribute('fetchpriority', 'high');
      img.addEventListener('error', function () {
        img.remove();
        photo.classList.add('qm-noimg');
        photo.appendChild(initial(item));
      });
      photo.appendChild(img);
    } else {
      photo.classList.add('qm-noimg');
      photo.appendChild(initial(item));
    }

    var body = document.createElement('div');
    body.className = 'qm-body';

    var name = document.createElement('h3');
    name.className = 'qm-name';
    name.textContent = item.n || '';

    var price = document.createElement('p');
    price.className = 'qm-price';
    price.textContent = money(item.p);

    body.appendChild(name);
    body.appendChild(price);
    card.appendChild(photo);
    card.appendChild(body);
    return card;
  }

  function initial(item) {
    var span = document.createElement('span');
    span.className = 'qm-ph';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = String(item.n || '?').charAt(0).toUpperCase();
    return span;
  }

  function groupItems(items) {
    var order = [];
    var map = {};
    items.forEach(function (it) {
      var key = String(it.c || '').trim() || t('all');
      if (!map[key]) {
        map[key] = [];
        order.push(key);
      }
      map[key].push(it);
    });
    return order.map(function (key) { return { name: key, items: map[key] }; });
  }

  function render() {
    if (!els.list) return;
    els.list.innerHTML = '';

    var query = state.q.trim().toLowerCase();
    var filtered = DATA.items.filter(function (it) {
      if (state.cat && String(it.c || '').trim() !== state.cat) return false;
      if (!query) return true;
      var hay = (String(it.n || '') + ' ' + String(it.c || '')).toLowerCase();
      return hay.indexOf(query) !== -1;
    });

    if (!filtered.length) {
      if (els.empty) {
        els.empty.hidden = !DATA.items.length ? true : false;
        var title = els.empty.querySelector('[data-i18n="noResults"]');
        if (title) title.textContent = t('noResults');
        var hint = els.empty.querySelector('[data-i18n="noResultsHint"]');
        if (hint) hint.textContent = t('noResultsHint');
      }
      return;
    }
    if (els.empty) els.empty.hidden = true;

    var eagerLeft = 6;
    groupItems(filtered).forEach(function (group) {
      var section = document.createElement('section');
      section.className = 'qm-cat';

      var head = document.createElement('h2');
      head.className = 'qm-h2';
      var label = document.createElement('span');
      label.textContent = group.name;
      var count = document.createElement('span');
      count.className = 'qm-count';
      count.textContent = group.items.length + ' ' + (group.items.length === 1 ? t('item') : t('items'));
      head.appendChild(label);
      head.appendChild(count);

      var grid = document.createElement('div');
      grid.className = 'qm-grid';
      group.items.forEach(function (it) {
        var eager = eagerLeft > 0;
        if (eager) eagerLeft -= 1;
        grid.appendChild(makeCard(it, eager));
      });

      section.appendChild(head);
      section.appendChild(grid);
      els.list.appendChild(section);
    });
  }

  /* ---------- search ------------------------------------------------------ */
  if (els.q) {
    els.q.addEventListener('input', function () {
      state.q = els.q.value || '';
      if (els.clear) els.clear.hidden = !state.q;
      render();
    });
    els.q.addEventListener('search', function () {
      state.q = els.q.value || '';
      if (els.clear) els.clear.hidden = !state.q;
      render();
    });
  }
  if (els.clear) {
    els.clear.addEventListener('click', function () {
      if (els.q) {
        els.q.value = '';
        els.q.focus();
      }
      state.q = '';
      els.clear.hidden = true;
      render();
    });
  }

  /* ---------- open / closed badge ----------------------------------------- */
  function parseTime(value) {
    var m = String(value || '').trim().match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    var ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function renderStatus() {
    if (!els.status) return;
    var open = parseTime(DATA.hours && DATA.hours.open);
    var close = parseTime(DATA.hours && DATA.hours.close);
    if (open === null || close === null) {
      els.status.hidden = true;
      return;
    }
    var now = new Date();
    var mins = now.getHours() * 60 + now.getMinutes();
    var isOpen = close > open ? (mins >= open && mins < close) : (mins >= open || mins < close);
    els.status.hidden = false;
    els.status.className = 'qm-badge ' + (isOpen ? 'qm-status-open' : 'qm-status-closed');
    els.status.innerHTML = '<span class="qm-dot" aria-hidden="true"></span><span></span>';
    els.status.lastChild.textContent = isOpen ? t('openNow') : t('closedNow');
  }

  /* ---------- menu card photo gallery + lightbox --------------------------- */
  var lastFocus = null;
  var photoIndex = 0;

  function buildGallery() {
    if (!els.gallery || !els.thumbs) return;
    if (!DATA.photos.length) {
      els.gallery.hidden = true;
      return;
    }
    els.gallery.hidden = false;
    els.thumbs.innerHTML = '';
    // With no dishes, the menu card is the menu — render it large.
    els.thumbs.className = 'qm-thumbs' + (DATA.items.length ? '' : ' qm-thumbs-solo');
    DATA.photos.forEach(function (src, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qm-thumb';
      /* Accessible name must contain the visible "Page N" caption. */
      btn.setAttribute('aria-label', t('menuPhotoAlt') + ' — ' + t('page') + ' ' + (i + 1));

      var img = document.createElement('img');
      img.src = src;
      img.alt = t('menuPhotoAlt') + ' ' + (i + 1);
      img.loading = i < 2 ? 'eager' : 'lazy';
      img.decoding = 'async';

      var label = document.createElement('span');
      label.className = 'qm-thumb-label';
      var labelText = document.createElement('span');
      labelText.setAttribute('data-i18n', 'page');
      labelText.textContent = t('page');
      label.appendChild(labelText);
      label.appendChild(document.createTextNode(' ' + (i + 1)));

      btn.appendChild(img);
      btn.appendChild(label);
      btn.addEventListener('click', function () { openLightbox(i); });
      els.thumbs.appendChild(btn);
    });
  }

  function openLightbox(index) {
    if (!els.lb || !els.lbImg) return;
    lastFocus = document.activeElement;
    photoIndex = index;
    showPhoto();
    els.lb.hidden = false;
    document.body.style.overflow = 'hidden';
    if (els.lbClose) els.lbClose.focus();
  }

  function showPhoto() {
    var src = DATA.photos[photoIndex];
    if (!src) return;
    els.lbImg.src = src;
    els.lbImg.alt = t('menuPhotoAlt') + ' ' + (photoIndex + 1);
    if (els.lbCount) {
      els.lbCount.textContent = t('page') + ' ' + (photoIndex + 1) + ' / ' + DATA.photos.length;
    }
  }

  function closeLightbox() {
    if (!els.lb) return;
    els.lb.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
  }

  if (els.lb) {
    els.lb.addEventListener('click', function (event) {
      if (event.target === els.lb) closeLightbox();
    });
  }
  if (els.lbClose) els.lbClose.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', function (event) {
    if (!els.lb || els.lb.hidden) return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowRight' && DATA.photos.length > 1) {
      photoIndex = (photoIndex + 1) % DATA.photos.length;
      showPhoto();
    }
    if (event.key === 'ArrowLeft' && DATA.photos.length > 1) {
      photoIndex = (photoIndex - 1 + DATA.photos.length) % DATA.photos.length;
      showPhoto();
    }
  });

  /* ---------- boot -------------------------------------------------------- */
  if (els.tools && !DATA.items.length) els.tools.hidden = true;
  buildGallery();
  applyLang(preferredLang(), false);
  renderStatus();
  setInterval(renderStatus, 60 * 1000);
})();
