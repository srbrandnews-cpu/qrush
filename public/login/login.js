/* Login + signup screen logic. */

(() => {
  const $ = (id) => document.getElementById(id);
  const isSignup = new URLSearchParams(location.search).get('mode') === 'signup';

  function showTab(mode) {
    const login = mode === 'login';
    $('tab-login').classList.toggle('active', login);
    $('tab-signup').classList.toggle('active', !login);
    $('form-login').classList.toggle('hidden', !login);
    $('form-signup').classList.toggle('hidden', login);
    // Keep the URL in sync so a refresh stays on the right tab.
    const url = login ? '/login' : '/login?mode=signup';
    history.replaceState(null, '', url);
  }

  $('tab-login').addEventListener('click', () => showTab('login'));
  $('tab-signup').addEventListener('click', () => showTab('signup'));
  showTab(isSignup ? 'signup' : 'login');

  // Where each role should land after login.
  const HOME = { owner: '/admin', kitchen: '/kitchen', cashier: '/cashier' };

  async function afterAuth(data) {
    TN.setToken(data.token);
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

  $('form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('signup-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating…';
    try {
      const data = await TN.api('/api/auth/signup', {
        noRedirect: true,
        body: {
          restaurant: $('su-restaurant').value.trim(),
          name: $('su-name').value.trim(),
          phone: $('su-phone').value.trim(),
          email: $('su-email').value.trim(),
          password: $('su-password').value,
        },
      });
      await afterAuth(data);
    } catch (err) {
      TN.toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Create account';
    }
  });
})();
