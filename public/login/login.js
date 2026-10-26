/* Login screen logic. Public signup is disabled — only the platform admin
   creates restaurants, so this screen has a single login form. */

(() => {
  const $ = (id) => document.getElementById(id);
  // Read this BEFORE anything rewrites the URL, otherwise it gets stripped.
  const wasExpired = new URLSearchParams(location.search).get('expired') === '1';

  // Drop stale ?mode=signup from older links.
  if (new URLSearchParams(location.search).get('mode') === 'signup') {
    history.replaceState(null, '', '/login' + (wasExpired ? '?expired=1' : ''));
  }

  // If the user was bounced here because the session expired, say so.
  if (wasExpired) {
    TN.toast('Aapka session khatam ho gaya tha. Dobara login karein.', 'error');
  }

  // Where each role should land after login.
  const HOME = { owner: '/admin', kitchen: '/kitchen', cashier: '/cashier' };

  async function afterAuth(data) {
    // Store under the role's own slot so other screens stay logged in.
    TN.setToken(data.token, data.user.role);
    TN.toast('Welcome, ' + data.user.name, 'success');
    window.location.href = HOME[data.user.role] || '/admin';
  }

  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Logging in…';
    try {
      const data = await TN.api('/api/auth/login', {
        noRedirect: true,
        body: { email: $('login-email').value.trim(), password: $('login-password').value },
      });
      await afterAuth(data);
    } catch (err) {
      TN.toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Login';
    }
  });
})();
