#!/usr/bin/env node
'use strict';

/**
 * Convert menu/logo images that were stored as HEIC (iPhone default) into
 * browser-friendly JPEG. Safe to run multiple times; only touches HEIC rows.
 *
 * usage:
 *   node scripts/fix-heic-menus.js            # convert everything
 *   node scripts/fix-heic-menus.js --dry-run  # report only
 *
 * Works with SQLite and Postgres (uses the same DB_CLIENT / DATABASE_URL
 * configuration as the app).
 */

const { query, run, close } = require('../src/config/db');
const { normalizeMenuData, normalizeLogo } = require('../src/utils/menu-image');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  console.log('Scanning for HEIC menu images...');
  const rows = await query(
    "SELECT id, slug, restaurant, menu_data, logo_url FROM free_qr_menus " +
    "WHERE LOWER(COALESCE(menu_data,'')) LIKE '%data:image/heic%' " +
    "   OR LOWER(COALESCE(menu_data,'')) LIKE '%data:image/heif%' " +
    "   OR LOWER(COALESCE(logo_url,'')) LIKE '%data:image/heic%' " +
    "   OR LOWER(COALESCE(logo_url,'')) LIKE '%data:image/heif%' " +
    'ORDER BY id'
  );

  if (!rows.length) {
    console.log('No HEIC menus found — nothing to do.');
    await close();
    return;
  }

  console.log('Found ' + rows.length + ' menu(s) with HEIC images' + (dryRun ? ' (dry run)' : '') + ':');

  for (const row of rows) {
    const before = String(row.menu_data || '').length;
    const beforeLogo = String(row.logo_url || '').length;

    let menu = String(row.menu_data || '');
    let logo = String(row.logo_url || '');

    if (!dryRun) {
      if (menu) menu = (await normalizeMenuData(menu)).value;
      if (logo) logo = (await normalizeLogo(logo)).value;
      await run('UPDATE free_qr_menus SET menu_data = ?, logo_url = ? WHERE id = ?', [
        menu || null,
        logo || null,
        row.id,
      ]);
    }

    console.log(
      '  #' + row.id,
      row.slug,
      '(' + (row.restaurant || 'unnamed') + ')',
      'menu ' + Math.round(before / 1024) + 'KB -> ' + Math.round(menu.length / 1024) + 'KB',
      beforeLogo ? '| logo ' + Math.round(beforeLogo / 1024) + 'KB -> ' + Math.round(logo.length / 1024) + 'KB' : ''
    );
  }

  console.log(dryRun ? 'Dry run complete.' : 'Done — HEIC images converted to JPEG.');
  await close();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await close(); } catch (_) {}
  process.exit(1);
});
