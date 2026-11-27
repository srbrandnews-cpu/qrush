(function () {
  const $ = (id) => document.getElementById(id);

  function wireDishUI() {
    const mtCard = $('d-mt-card');
    const mtItems = $('d-mt-items');
    if (mtCard) mtCard.addEventListener('click', () => setMenuTab('card'));
    if (mtItems) mtItems.addEventListener('click', () => setMenuTab('items'));

    const addBtn = $('d-item-add');
    if (addBtn) addBtn.addEventListener('click', () => openDishModal(-1));
    const pasteBtn = $('d-item-paste');
    if (pasteBtn) pasteBtn.addEventListener('click', openBulkModal);
    const autoBtn = $('d-item-auto');
    if (autoBtn) autoBtn.addEventListener('click', autoPhotosAll);

    // portion switch
    var ptS = document.getElementById('dish-pt-single');
    var ptH = document.getElementById('dish-pt-halfull');
    if (ptS) ptS.addEventListener('click', function () {
      ptS.classList.add('on'); if (ptH) ptH.classList.remove('on');
      var sp = document.getElementById('dish-price-single'); var hp = document.getElementById('dish-price-halffull');
      if (sp) sp.hidden = false; if (hp) hp.hidden = true;
    });
    if (ptH) ptH.addEventListener('click', function () {
      ptH.classList.add('on'); if (ptS) ptS.classList.remove('on');
      var sp = document.getElementById('dish-price-single'); var hp = document.getElementById('dish-price-halffull');
      if (sp) sp.hidden = true; if (hp) hp.hidden = false;
    });

    const dishClose = $('dish-close');
    if (dishClose) dishClose.addEventListener('click', closeDishModal);
    const dishCancel = $('dish-cancel');
    if (dishCancel) dishCancel.addEventListener('click', closeDishModal);
    const dishSave = $('dish-save');
    if (dishSave) dishSave.addEventListener('click', saveDish);
    const dishDelete = $('dish-delete');
    if (dishDelete) dishDelete.addEventListener('click', () => {
      const idx = (typeof editingDishIdx !== 'undefined') ? editingDishIdx : -1;
      // editingDishIdx is in chunk B scope; re-derive from modal title? Use a global mirror.
      if (window._editingDishIdx >= 0) deleteDish(window._editingDishIdx);
      else closeDishModal();
    });

    const dishPhoto = $('dish-photo');
    if (dishPhoto) dishPhoto.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!/^image\//i.test(file.type || '')) { toast('Sirf image upload kar sakte hain', true); return; }
      try {
        const dataUrl = await prepareImageFile(file, { maxDim: 900, quality: 0.78, keepUnder: 120 * 1024 });
        if (dataUrl && dataUrl.length > 1.8 * 1024 * 1024) throw new Error('Photo bahut badi hai');
        setDishPhoto(dataUrl);
      } catch (err) {
        toast(err.message || 'Photo upload nahi hui', true);
      }
    });
    const dishPhotoAuto = $('dish-photo-auto');
    if (dishPhotoAuto) dishPhotoAuto.addEventListener('click', () => {
      const name = ($('dish-name').value || '').trim();
      const auto = autoDishPhoto(name);
      if (auto) setDishPhoto(auto);
      else toast('Is naam ke liye sample photo nahi mila. Photo upload karein.', true);
    });
    const dishPhotoClear = $('dish-photo-clear');
    if (dishPhotoClear) dishPhotoClear.addEventListener('click', () => setDishPhoto(''));

    const dishName = $('dish-name');
    if (dishName) dishName.addEventListener('input', () => {
      const thumb = $('dish-thumb');
      if (thumb && !thumb.querySelector('img') && !pendingDishImage) {
        thumb.textContent = String(dishName.value || '?').charAt(0).toUpperCase() || 'dish';
      }
    });

    const dishList = $('d-items');
    if (dishList) dishList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const idx = Number(btn.getAttribute('data-idx'));
      const act = btn.getAttribute('data-act');
      if (act === 'dish-edit') openDishModal(idx);
      else if (act === 'dish-del') deleteDish(idx);
    });

    const bulkClose = $('bulk-close');
    if (bulkClose) bulkClose.addEventListener('click', closeBulkModal);
    const bulkCancel = $('bulk-cancel');
    if (bulkCancel) bulkCancel.addEventListener('click', closeBulkModal);
    const bulkSave = $('bulk-save');
    if (bulkSave) bulkSave.addEventListener('click', saveBulk);

    const dishModal = $('dish-modal');
    if (dishModal) dishModal.addEventListener('click', (e) => { if (e.target === dishModal) closeDishModal(); });
    const bulkModal = $('bulk-modal');
    if (bulkModal) bulkModal.addEventListener('click', (e) => { if (e.target === bulkModal) closeBulkModal(); });
  }

  // Keep a global mirror of editingDishIdx for chunk D delete button.
  // Monkeypatch openDishModal to record it.
  const _open = window.openDishModal;
  window.openDishModal = function (idx) {
    window._editingDishIdx = (typeof idx === 'number' && idx >= 0) ? idx : -1;
    return _open.apply(this, arguments);
  };
  const _close = window.closeDishModal;
  window.closeDishModal = function () {
    window._editingDishIdx = -1;
    return _close.apply(this, arguments);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireDishUI);
  } else {
    wireDishUI();
  }
})();

