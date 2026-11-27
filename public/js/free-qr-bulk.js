(function () {
  const $ = (id) => document.getElementById(id);

  function openBulkModal() {
    const m = $('bulk-modal');
    const t = $('bulk-text');
    if (t) t.value = '';
    const e = $('bulk-error');
    if (e) e.textContent = '';
    if (m) m.classList.remove('hidden');
    setTimeout(() => { if (t) t.focus(); }, 50);
  }
  function closeBulkModal() {
    const m = $('bulk-modal');
    if (m) m.classList.add('hidden');
  }
  async function saveBulk() {
    const text = ($('bulk-text').value || '').trim();
    const err = $('bulk-error');
    if (!text) { if (err) err.textContent = 'Kuch paste karein.'; return; }
    const parsed = parseItemsText(text);
    if (!parsed.length) { if (err) err.textContent = 'Koi dish nahi pehchana. Format: Naam, price, category'; return; }
    parsed.forEach(it => { if (!it.image) { const a = autoDishPhoto(it.name); if (a) it.image = a; } });
    const items = (currentItems || []).slice().concat(parsed);
    const btn = $('bulk-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
    try {
      const out = await saveItems({ items });
      applyOwnerPayload(out);
      revision = Date.now();
      renderDashboard();
      closeBulkModal();
      toast(parsed.length + ' dishes add ho gaye!');
    } catch (e) {
      if (err) err.textContent = e.message || 'Add nahi hua';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add dishes'; }
    }
  }
  async function autoPhotosAll() {
    const items = (currentItems || []).slice();
    let changed = 0;
    items.forEach(it => {
      if (!it.image) {
        const a = autoDishPhoto(it.name);
        if (a) { it.image = a; changed++; }
      }
    });
    if (!changed) { toast('Sab dishes ke paas pehle se photo hai (ya koi match nahi mila).', true); return; }
    try {
      const out = await saveItems({ items });
      applyOwnerPayload(out);
      revision = Date.now();
      renderDashboard();
      toast(changed + ' dishes ko sample photo mil gaya!');
    } catch (e) {
      toast(e.message || 'Save nahi hua', true);
    }
  }

  // Wrap runMenuOcr (defined in first script) to switch to items tab after.
  if (typeof window.runMenuOcr === 'function') {
    const orig = window.runMenuOcr;
    window.runMenuOcr = function () {
      const r = orig.apply(this, arguments);
      if (r && typeof r.then === 'function') {
        r.then(() => { try { setMenuTab('items'); renderDishes(); } catch (_) {} }).catch(() => {});
      }
      return r;
    };
  }

  window.openBulkModal = openBulkModal;
  window.closeBulkModal = closeBulkModal;
  window.saveBulk = saveBulk;
  window.autoPhotosAll = autoPhotosAll;
})();

