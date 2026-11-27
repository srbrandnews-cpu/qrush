(function () {
  const $ = (id) => document.getElementById(id);

  const AUTO_PHOTOS = {
    'paneer tikka': '/img/demo/paneer-tikka.jpg',
    'chicken tikka': '/img/demo/chicken-tikka.jpg',
    'butter chicken': '/img/demo/butter-chicken.jpg',
    'paneer butter masala': '/img/demo/paneer-butter-masala.jpg',
    'dal makhani': '/img/demo/dal-makhani.jpg',
    'kadai chicken': '/img/demo/kadai-chicken.jpg',
    'veg kolhapuri': '/img/demo/veg-kolhapuri.jpg',
    'spring roll': '/img/demo/veg-spring-rolls.jpg',
    'mushroom': '/img/demo/tandoori-mushroom.jpg',
    'butter naan': '/img/demo/butter-naan.jpg',
    'garlic naan': '/img/demo/garlic-naan.jpg',
    'jeera rice': '/img/demo/jeera-rice.jpg',
    'pulao': '/img/demo/veg-pulao.jpg',
    'gulab jamun': '/img/demo/gulab-jamun.jpg',
    'rasgulla': '/img/demo/rasgulla.jpg',
    'masala chai': '/img/demo/masala-chai.jpg',
    'lassi': '/img/demo/sweet-lassi.jpg',
    'lime soda': '/img/demo/fresh-lime-soda.jpg',
    'biryani': '/img/landing/biryani.jpg',
    'thali': '/img/landing/thali.jpg',
    'curry': '/img/landing/curry.jpg',
  };
  function autoDishPhoto(name) {
    const n = String(name || '').toLowerCase();
    for (const k in AUTO_PHOTOS) {
      if (n.includes(k)) return AUTO_PHOTOS[k];
    }
    if (n.includes('paneer')) return '/img/demo/paneer-butter-masala.jpg';
    if (n.includes('chicken') || n.includes('mutton')) return '/img/demo/chicken-tikka.jpg';
    if (n.includes('naan') || n.includes('roti') || n.includes('paratha')) return '/img/demo/butter-naan.jpg';
    if (n.includes('rice') || n.includes('biryani') || n.includes('pulao')) return '/img/demo/jeera-rice.jpg';
    if (n.includes('dal') || n.includes('curry') || n.includes('masala')) return '/img/demo/dal-makhani.jpg';
    if (n.includes('gulab') || n.includes('rasgulla') || n.includes('halwa') || n.includes('kheer') || n.includes('dessert')) return '/img/demo/gulab-jamun.jpg';
    if (n.includes('chai') || n.includes('lassi') || n.includes('soda') || n.includes('drink') || n.includes('juice')) return '/img/demo/masala-chai.jpg';
    if (n.includes('roll') || n.includes('spring') || n.includes('tikka')) return '/img/demo/veg-spring-rolls.jpg';
    return '';
  }
  function dishThumbHtml(item) {
    if (item && item.image) return '<img src="' + esc(item.image) + '" alt="" />';
    return String((item && item.name) || '?').charAt(0).toUpperCase();
  }
  function renderDishes() {
    const container = document.getElementById('d-items');
    const countEl = document.getElementById('d-item-count');
    if (!container) return;
    const items = Array.isArray(currentItems) ? currentItems : [];
    if (countEl) countEl.textContent = items.length ? '(' + items.length + ')' : '';
    if (!items.length) {
      container.innerHTML = '<div class="dish-empty"><div class="title">Koi dish nahi hai abhi</div>Add karne ke liye "+ Add dish" dabayein, ya "Paste list" se bulk add karein.</div>';
      return;
    }
    container.innerHTML = items.map((it, idx) => (
      '<div class="dish-row" data-idx="' + idx + '">' +
      '<div class="dish-thumb">' + dishThumbHtml(it) + '</div>' +
      '<div class="dish-meta">' +
        '<div class="nm">' + esc(it.name) + '</div>' +
        '<div class="sub">' + esc(it.category || 'Uncategorized') + (it.available === false ? ' · hidden' : '') + '</div>' +
      '</div>' +
      '<div class="dish-price">' + ( (it.half || it.full) ? ('H ₹' + (Number(it.half)||0) + (it.full ? ' · F ₹' + Number(it.full) : '')) : ('₹' + (Number(it.price) || 0)) ) + '</div>' +
      '<button class="btn btn-outline btn-sm" data-act="dish-edit" data-idx="' + idx + '" type="button">Edit</button>' +
      '<button class="btn btn-ghost btn-sm" data-act="dish-del" data-idx="' + idx + '" type="button">X</button>' +
      '</div>'
    )).join('');
  }
  window.renderDishes = renderDishes;
  window.autoDishPhoto = autoDishPhoto;
  window.dishThumbHtml = dishThumbHtml;

  function setMenuTab(tab) {
    const card = document.getElementById('d-pane-card');
    const items = document.getElementById('d-pane-items');
    const bCard = document.getElementById('d-mt-card');
    const bItems = document.getElementById('d-mt-items');
    if (!card || !items) return;
    const showCard = tab === 'card';
    card.hidden = !showCard;
    items.hidden = showCard;
    if (bCard) bCard.classList.toggle('on', showCard);
    if (bItems) bItems.classList.toggle('on', !showCard);
    try { localStorage.setItem('fq_menu_tab', tab); } catch (_) {}
  }
  window.setMenuTab = setMenuTab;

  function initMenuTab() {
    let tab = 'card';
    try { tab = localStorage.getItem('fq_menu_tab') || tab; } catch (_) {}
    if (currentItems && currentItems.length && !(current && current.menu_urls && current.menu_urls.length)) tab = 'items';
    setMenuTab(tab);
  }
  window.initMenuTab = initMenuTab;

  // Wrap renderDashboard to call renderDishes + initMenuTab after it runs.
  if (typeof window.renderDashboard === 'function') {
    const orig = window.renderDashboard;
    window.renderDashboard = function () {
      const r = orig.apply(this, arguments);
      try { initMenuTab(); } catch (_) {}
      try { renderDishes(); } catch (_) {}
      return r;
    };
  }
})();

