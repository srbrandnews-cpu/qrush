'use strict';

/**
 * Platform console (super-admin) regression test.
 *
 *   BASE_URL=http://localhost:3100 node scripts/test-superadmin.js
 *
 * Covers: overview KPIs, tenant creation, access control (non-super owner is
 * blocked), suspend/rename, owner password reset, and cascade delete.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function call(path, { method = 'GET', token, body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text() };
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

async function login(email, password) {
  return call('/api/auth/login', { method: 'POST', body: { email, password } });
}

async function main() {
  console.log('\n=== QRush super-admin console test ===\n');

  const superLogin = await login('owner@demo.com', 'pass1234');
  assert(superLogin.status === 200 && superLogin.data.token, 'demo platform owner login works');
  assert(superLogin.data.user.is_super_admin === true, 'login response flags the super admin');
  const superToken = superLogin.data.token;

  const unauth = await call('/api/admin/super-admin/overview');
  assert(unauth.status === 401, 'overview needs a login');

  const overview = await call('/api/admin/super-admin/overview', { token: superToken });
  assert(overview.status === 200, 'platform overview loads');
  assert(overview.data.stats && Number(overview.data.stats.tenants_total) >= 1, 'overview returns tenant KPI');
  assert(Array.isArray(overview.data.tenants), 'overview returns the restaurant list');
  assert(Array.isArray(overview.data.meta.super_admins) && overview.data.meta.super_admins.length, 'allowlist is exposed to the console');
  assert(!!overview.data.meta.database, 'overview reports the database driver');

  const page = await call('/superadmin', { raw: true });
  assert(page.status === 200 && /Platform console/i.test(page.text), 'super-admin page is served');

  const stamp = Date.now();
  const restaurant = 'Test Platform Venue ' + stamp;
  const email = 'platform-test-' + stamp + '@example.com';
  const password = 'QRush-Test-' + String(stamp).slice(-5);
  let tenantId = null;
  let ownerPassword = password;

  try {
    const created = await call('/api/admin/super-admin/tenants', {
      method: 'POST',
      token: superToken,
      body: { restaurant, name: 'Platform Test', email, password, phone: '9876543210' },
    });
    assert(created.status === 201 && created.data.tenant && created.data.owner, 'super admin can create a restaurant');
    tenantId = created.data.tenant.id;
    assert(created.data.tenant.is_active === 1, 'new restaurant starts active');
    assert(created.data.owner.email === email && created.data.owner.role === 'owner', 'owner account is created');

    const list = await call('/api/admin/super-admin/tenants', { token: superToken });
    const row = list.data.tenants.find((t) => Number(t.id) === Number(tenantId));
    assert(!!row, 'new restaurant appears in the platform list');
    assert(row.owner_email === email, 'platform list shows the owner email');
    assert(Number(row.tables_count) === 0 && Number(row.menu_count) === 0, 'new restaurant starts with a clean setup');

    // A normal venue owner must not get platform powers.
    const ownerLogin = await login(email, password);
    assert(ownerLogin.status === 200 && ownerLogin.data.user.is_super_admin === false, 'new owner is not a super admin');
    const blocked = await call('/api/admin/super-admin/overview', { token: ownerLogin.data.token });
    assert(blocked.status === 403, 'normal owner is blocked from the platform overview');
    const blockedCreate = await call('/api/admin/super-admin/tenants', {
      method: 'POST',
      token: ownerLogin.data.token,
      body: { restaurant: 'Hack', name: 'Hack', email: 'hack-' + stamp + '@example.com', password: 'hackpass1' },
    });
    assert(blockedCreate.status === 403, 'normal owner cannot create restaurants');

    const patched = await call(`/api/admin/super-admin/tenants/${tenantId}`, {
      method: 'PATCH',
      token: superToken,
      body: { name: restaurant + ' Renamed', is_active: false },
    });
    assert(patched.status === 200 && patched.data.tenant.is_active === 0, 'super admin can suspend a venue');

    const suspended = await call('/api/admin/super-admin/tenants', { token: superToken });
    const suspendedRow = suspended.data.tenants.find((t) => Number(t.id) === Number(tenantId));
    assert(Number(suspendedRow.is_active) === 0, 'suspended status is reflected in the list');

    const selfSuspend = await call('/api/admin/super-admin/tenants/' + superLogin.data.tenant.id, {
      method: 'PATCH',
      token: superToken,
      body: { is_active: false },
    });
    assert(selfSuspend.status === 400, 'you cannot suspend your own workspace');

    ownerPassword = 'NewPass-' + String(stamp).slice(-6);
    const reset = await call(`/api/admin/super-admin/tenants/${tenantId}/owner`, {
      method: 'PUT',
      token: superToken,
      body: { password: ownerPassword },
    });
    assert(reset.status === 200 && reset.data.owner.email === email, 'owner password can be reset');

    const oldLogin = await login(email, password);
    assert(oldLogin.status === 401, 'old owner password stops working');
    const newLogin = await login(email, ownerPassword);
    assert(newLogin.status === 200, 'new owner password works');

    const deleted = await call(`/api/admin/super-admin/tenants/${tenantId}`, {
      method: 'DELETE',
      token: superToken,
    });
    assert(deleted.status === 200, 'super admin can delete a restaurant');
    tenantId = null;

    const after = await call('/api/admin/super-admin/tenants', { token: superToken });
    assert(!after.data.tenants.some((t) => t.owner_email === email), 'deleted restaurant is gone');

    const deadLogin = await login(email, ownerPassword);
    assert(deadLogin.status === 401, 'deleted owner account cannot log in');
  } finally {
    if (tenantId) {
      const cleanup = await call(`/api/admin/super-admin/tenants/${tenantId}`, {
        method: 'DELETE',
        token: superToken,
      });
      if (cleanup.status !== 200) console.warn('  ! cleanup failed for tenant ' + tenantId);
    }
  }

  console.log('\n✅ Super-admin console tests passed!\n');
}

main().catch((err) => {
  console.error('\n' + err.message + '\n');
  process.exit(1);
});
