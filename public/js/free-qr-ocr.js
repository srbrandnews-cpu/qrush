(function () {
  async function autoGenerateFromCard(askConfirm) {
    try {
      if (!current || !current.menu_url) {
        toast('Pehle menu card photo upload karein', true);
        return;
      }
      if (isPdf()) {
        toast('PDF se auto dish list nahi ban sakta — image upload karein', true);
        return;
      }
      if (currentItems && currentItems.length) {
        if (askConfirm && !confirm('Purane ' + currentItems.length + ' dishes replace ho jayenge. Continue?')) return;
      }
      toast('Menu card se dishes detect ho rahi hain (OCR)...');
      await runMenuOcr(withRev(current.menu_url));
      setMenuTab('items');
      renderDishes();
      const n = (currentItems || []).length;
      if (n) toast('✅ ' + n + ' dishes menu card se auto-generate ho gaye!');
      else toast('Koi dish detect nahi hua. Clear image try karein.', true);
    } catch (e) {
      toast((e && e.message) ? e.message : 'Auto-generate nahi hua', true);
    }
  }
  window.autoGenerateFromCard = autoGenerateFromCard;
})();

