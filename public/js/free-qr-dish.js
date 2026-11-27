(function () {
  const $ = (id) => document.getElementById(id);

  let editingDishIdx = -1;
  let pendingDishImage = undefined;

  function openDishModal(idx) {
    editingDishIdx = (typeof idx === 'number' && idx >= 0) ? idx : -1;
    const modal = $('dish-modal');
    const title = $('dish-title');
    const name = $('dish-name');
    const price = $('dish-price');
    const cat = $('dish-cat');
    const avail = $('dish-available');
    const thumb = $('dish-thumb');
    const delBtn = $('dish-delete');
    pendingDishImage = undefined;

    const cats = [...new Set((currentItems || []).map(i => i.category).filter(Boolean))];
    const dl = $('dish-cat-list');
    if (dl) dl.innerHTML = cats.map(c => '<option value="' + esc(c) + '"></option>').join('');

    if (editingDishIdx >= 0 && currentItems[editingDishIdx]) {
      const it = currentItems[editingDishIdx];
      if (title) title.textContent = 'Edit dish';
      if (name) name.value = it.name || '';
      if (price) price.value = it.price || 0;
      var halfIn = document.getElementById('dish-half');
      var fullIn = document.getElementById('dish-full');
      if (halfIn) halfIn.value = it.half || '';
      if (fullIn) fullIn.value = it.full || '';
      var isHalfFull = !!(it.half || it.full);
      var singlePane = document.getElementById('dish-price-single');
      var halfPane = document.getElementById('dish-price-halffull');
      if (singlePane) singlePane.hidden = isHalfFull;
      if (halfPane) halfPane.hidden = !isHalfFull;
      var ptSingle = document.getElementById('dish-pt-single');
      var ptHalf = document.getElementById('dish-pt-halfull');
      if (ptSingle) ptSingle.classList.toggle('on', !isHalfFull);
      if (ptHalf) ptHalf.classList.toggle('on', isHalfFull);
      if (cat) cat.value = it.category || '';
      var descIn = document.getElementById('dish-desc');
      if (descIn) descIn.value = it.description || '';
      if (avail) avail.checked = it.available !== false;
      if (thumb) thumb.innerHTML = it.image ? '<img src="' + esc(it.image) + '" alt="" />' : (String(it.name || '?').charAt(0).toUpperCase());
      if (delBtn) delBtn.style.display = '';
    } else {
      if (title) title.textContent = 'Add dish';
      if (name) name.value = '';
      if (price) price.value = '';
      var halfIn2 = document.getElementById('dish-half');
      var fullIn2 = document.getElementById('dish-full');
      if (halfIn2) halfIn2.value = '';
      if (fullIn2) fullIn2.value = '';
      var sp = document.getElementById('dish-price-single');
      var hp = document.getElementById('dish-price-halffull');
      if (sp) sp.hidden = false;
      if (hp) hp.hidden = true;
      var pts = document.getElementById('dish-pt-single');
      var pth = document.getElementById('dish-pt-halfull');
      if (pts) pts.classList.add('on');
      if (pth) pth.classList.remove('on');
      if (cat) cat.value = '';
      var descIn2 = document.getElementById('dish-desc');
      if (descIn2) descIn2.value = '';
      if (avail) avail.checked = true;
      if (thumb) thumb.innerHTML = 'dish';
      if (delBtn) delBtn.style.display = 'none';
    }
    const err = $('dish-error');
    if (err) err.textContent = '';
    if (modal) modal.classList.remove('hidden');
    setTimeout(() => { if (name) name.focus(); }, 50);
  }
  function closeDishModal() {
    const modal = $('dish-modal');
    if (modal) modal.classList.add('hidden');
    editingDishIdx = -1;
    pendingDishImage = undefined;
  }
  window.openDishModal = openDishModal;
  window.closeDishModal = closeDishModal;

  function setDishPhoto(dataUrl) {
    pendingDishImage = dataUrl;
    const thumb = $('dish-thumb');
    if (thumb) {
      if (dataUrl) thumb.innerHTML = '<img src="' + dataUrl + '" alt="" />';
      else thumb.innerHTML = String(($('dish-name').value || '?')).charAt(0).toUpperCase() || 'dish';
    }
  }
  window.setDishPhoto = setDishPhoto;

  async function saveDish() {
    const name = ($('dish-name').value || '').trim();
    const ptHalfull = document.getElementById('dish-pt-halfull');
    const isHalfFull = !!(ptHalfull && ptHalfull.classList.contains('on'));
    var price = 0, half = null, full = null;
    if (isHalfFull) {
      half = Number((document.getElementById('dish-half').value) || 0) || 0;
      full = Number((document.getElementById('dish-full').value) || 0) || 0;
      if (full <= 0) { if (err) err.textContent = 'Full price zaroori hai.'; if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save dish'; } return; }
      price = full;
    } else {
      price = Number($('dish-price').value) || 0;
    }
    const cat = ($('dish-cat').value || '').trim();
    const desc = (document.getElementById('dish-desc').value || '').trim();
    const avail = $('dish-available').checked;
    const err = $('dish-error');
    if (!name) { if (err) err.textContent = 'Dish ka naam zaroori hai.'; return; }
    if (price < 0) { if (err) err.textContent = 'Price galat hai.'; return; }

    const items = (currentItems || []).slice();
    const dish = { name, price, category: cat, available: avail };
    dish.description = desc;
    if (isHalfFull) { dish.half = half; dish.full = full; }
    else { dish.half = null; dish.full = null; }
    if (pendingDishImage !== undefined) dish.image = pendingDishImage;
    if (editingDishIdx < 0 && pendingDishImage === undefined) {
      const auto = autoDishPhoto(name);
      if (auto) dish.image = auto;
    }
    if (editingDishIdx >= 0 && items[editingDishIdx]) {
      dish.id = items[editingDishIdx].id;
      if (pendingDishImage === undefined) delete dish.image;
      items[editingDishIdx] = { ...items[editingDishIdx], ...dish };
    } else {
      items.push(dish);
    }

    const saveBtn = $('dish-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
    try {
      const out = await saveItems({ items });
      applyOwnerPayload(out);
      revision = Date.now();
      renderDashboard();
      closeDishModal();
      toast('Dish save ho gaya!');
    } catch (e) {
      if (err) err.textContent = e.message || 'Save nahi hua';
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save dish'; }
    }
  }
  async function deleteDish(idx) {
    if (!confirm('Is dish ko delete karna hai?')) return;
    const items = (currentItems || []).slice();
    items.splice(idx, 1);
    try {
      const out = await saveItems({ items });
      applyOwnerPayload(out);
      revision = Date.now();
      renderDashboard();
      toast('Dish delete ho gaya');
    } catch (e) {
      toast(e.message || 'Delete nahi hua', true);
    }
  }
  window.saveDish = saveDish;
  window.deleteDish = deleteDish;
  window.editingDishIdxRef = () => editingDishIdx;
  window.setEditingDishIdx = (v) => { editingDishIdx = v; };
})();

