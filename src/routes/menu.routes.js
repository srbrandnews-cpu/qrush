'use strict';

const express = require('express');
const { query, get, run, transaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/menu  -> categories with their items for the logged-in restaurant.
 */
router.get('/', async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const categories = await query(
      'SELECT * FROM menu_categories WHERE tenant_id = ? ORDER BY sort_order, id',
      [tenantId]
    );
    const items = await query(
      'SELECT * FROM menu_items WHERE tenant_id = ? ORDER BY sort_order, id',
      [tenantId]
    );
    const withItems = categories.map((c) => ({
      ...c,
      items: items.filter((i) => i.category_id === c.id),
    }));
    // Items with no category still need to show up somewhere.
    const uncategorized = items.filter((i) => !i.category_id || !categories.some((c) => c.id === i.category_id));
    res.json({ categories: withItems, uncategorized });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- categories ----------------------------- */

router.post('/categories', requireRole('owner'), async (req, res, next) => {
  try {
    const { name, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    const max = await get('SELECT MAX(sort_order) AS m FROM menu_categories WHERE tenant_id = ?', [req.user.tenant_id]);
    const sort = Number.isFinite(Number(sort_order)) ? Number(sort_order) : (max.m || 0) + 1;
    const r = await run(
      'INSERT INTO menu_categories (tenant_id, name, sort_order) VALUES (?, ?, ?)',
      [req.user.tenant_id, String(name).trim(), sort]
    );
    res.status(201).json(await get('SELECT * FROM menu_categories WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) {
    next(err);
  }
});

router.put('/categories/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const cat = await ownedCategory(req.user.tenant_id, req.params.id);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const { name, sort_order, is_active } = req.body || {};
    await run(
      `UPDATE menu_categories SET
         name = ?, sort_order = ?, is_active = ?
       WHERE id = ?`,
      [
        name != null ? String(name).trim() : cat.name,
        Number.isFinite(Number(sort_order)) ? Number(sort_order) : cat.sort_order,
        is_active != null ? (is_active ? 1 : 0) : cat.is_active,
        cat.id,
      ]
    );
    res.json(await get('SELECT * FROM menu_categories WHERE id = ?', [cat.id]));
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const cat = await ownedCategory(req.user.tenant_id, req.params.id);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    // Items are kept but become uncategorized.
    await run('UPDATE menu_items SET category_id = NULL WHERE category_id = ?', [cat.id]);
    await run('DELETE FROM menu_categories WHERE id = ?', [cat.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- items -------------------------------- */

router.post('/items', requireRole('owner'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Item name is required' });
    const price = Number(b.price);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'A valid price is required' });

    const categoryId = b.category_id ? Number(b.category_id) : null;
    if (categoryId && !(await ownedCategory(req.user.tenant_id, categoryId))) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const max = await get('SELECT MAX(sort_order) AS m FROM menu_items WHERE tenant_id = ?', [req.user.tenant_id]);
    const sort = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : (max.m || 0) + 1;

    const r = await run(
      `INSERT INTO menu_items (tenant_id, category_id, name, description, price, image_url, is_veg, is_available, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.tenant_id, categoryId, String(b.name).trim(),
        b.description ? String(b.description).trim() : null,
        price, b.image_url ? String(b.image_url).trim() : null,
        b.is_veg ? 1 : 0,
        b.is_available === false ? 0 : 1,
        sort,
      ]
    );
    res.status(201).json(await get('SELECT * FROM menu_items WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) {
    next(err);
  }
});

router.put('/items/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const item = await ownedItem(req.user.tenant_id, req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const b = req.body || {};

    let categoryId = item.category_id;
    if (b.category_id !== undefined) {
      categoryId = b.category_id ? Number(b.category_id) : null;
      if (categoryId && !(await ownedCategory(req.user.tenant_id, categoryId))) {
        return res.status(400).json({ error: 'Invalid category' });
      }
    }

    const price = b.price !== undefined ? Number(b.price) : item.price;
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'A valid price is required' });

    await run(
      `UPDATE menu_items SET
         category_id = ?, name = ?, description = ?, price = ?, image_url = ?,
         is_veg = ?, is_available = ?, sort_order = ?
       WHERE id = ?`,
      [
        categoryId,
        b.name != null ? String(b.name).trim() : item.name,
        b.description !== undefined ? (b.description ? String(b.description).trim() : null) : item.description,
        price,
        b.image_url !== undefined ? (b.image_url ? String(b.image_url).trim() : null) : item.image_url,
        b.is_veg != null ? (b.is_veg ? 1 : 0) : item.is_veg,
        b.is_available != null ? (b.is_available ? 1 : 0) : item.is_available,
        Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : item.sort_order,
        item.id,
      ]
    );
    res.json(await get('SELECT * FROM menu_items WHERE id = ?', [item.id]));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/menu/items/:id/availability  { is_available }
 * Quick "86'd / back in stock" toggle from the kitchen board.
 */
router.patch('/items/:id/availability', requireRole('owner', 'kitchen'), async (req, res, next) => {
  try {
    const item = await ownedItem(req.user.tenant_id, req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const isAvailable = req.body && req.body.is_available ? 1 : 0;
    await run('UPDATE menu_items SET is_available = ? WHERE id = ?', [isAvailable, item.id]);
    res.json(await get('SELECT * FROM menu_items WHERE id = ?', [item.id]));
  } catch (err) {
    next(err);
  }
});

router.delete('/items/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const item = await ownedItem(req.user.tenant_id, req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    await run('DELETE FROM menu_items WHERE id = ?', [item.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ CSV import ----------------------------- */

/**
 * GET /api/menu/template.csv
 * A ready-to-fill CSV the restaurant owner can download and edit.
 */
router.get('/template.csv', (req, res) => {
  const sample = [
    'Category,Item Name,Description,Price,Veg',
    'Starters,Paneer Tikka,"Char-grilled cottage cheese, mint chutney",260,Veg',
    'Starters,Chicken Tikka,"Smoky tandoori skewers",320,Non-veg',
    'Main Course,Paneer Butter Masala,"Rich tomato-cashew gravy",280,Veg',
    'Main Course,Butter Chicken,"Classic murgh makhani",360,Non-veg',
    'Breads,Butter Naan,"Tandoor baked",60,Veg',
    'Beverages,Masala Chai,"Spiced Indian tea",40,Veg',
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="qrush-menu-template.csv"');
  res.send('\uFEFF' + sample); // BOM so Excel opens UTF-8 (₹ etc.) correctly
});

/**
 * POST /api/menu/import  { csv: "<file contents>", mode: "append" | "replace" }
 *
 * Bulk-adds a whole menu from a CSV. Missing categories are created
 * automatically. Row-level problems are reported but never abort the import.
 */
router.post('/import', requireRole('owner'), async (req, res, next) => {
  try {
    const { csv, mode } = req.body || {};
    if (!csv || !String(csv).trim()) {
      return res.status(400).json({ error: 'CSV content is empty' });
    }

    const parse = require('csv-parse/sync').parse;
    let records;
    try {
      records = parse(String(csv), {
        columns: (header) => header.map((h) => h.trim().toLowerCase()),
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
        bom: true,
      });
    } catch (parseErr) {
      return res.status(400).json({ error: 'CSV could not be read: ' + parseErr.message });
    }
    if (!records.length) {
      return res.status(400).json({ error: 'CSV has no rows' });
    }

    // Map the columns we understand (several header spellings are accepted).
    const col = {
      category: find(records[0], ['category', 'category_name', 'section', 'group']),
      name: find(records[0], ['item name', 'item_name', 'name', 'dish', 'item']),
      description: find(records[0], ['description', 'desc', 'details']),
      price: find(records[0], ['price', 'rate', 'amount', 'cost']),
      veg: find(records[0], ['veg', 'type', 'veg_nonveg', 'veg/non-veg', 'diet']),
      image: find(records[0], ['image', 'image_url', 'image url', 'photo']),
    };
    if (!col.name) {
      return res.status(400).json({
        error: 'CSV needs an "Item Name" column. Download the template for the right format.',
      });
    }

    const tenantId = req.user.tenant_id;
    const errors = [];
    const items = [];

    records.forEach((row, i) => {
      const line = i + 2; // +1 for header, +1 for 1-based line numbers
      const name = (row[col.name] || '').trim();
      if (!name) {
        errors.push({ line, error: 'Item name is empty' });
        return;
      }
      // Price: allow currency symbols & thousand separators, but anything
      // non-numeric must be reported as an error. (Number('') is 0, so an
      // empty/garbage price must be caught explicitly — never saved as ₹0.)
      const rawPrice = col.price ? String(row[col.price] || '').trim() : '';
      const cleaned = rawPrice.replace(/[₹$€£,\s]/g, '');
      const price = Number(cleaned);
      if (!rawPrice || cleaned === '' || !Number.isFinite(price) || price < 0) {
        errors.push({ line, error: `"${name}" — price "${rawPrice}" is not a valid number` });
        return;
      }
      const vegRaw = col.veg ? String(row[col.veg] || '').toLowerCase().trim() : 'veg';
      const isVeg = !(vegRaw.includes('non') || vegRaw === '0' || vegRaw === 'false' || vegRaw === 'no');
      items.push({
        category: (col.category ? String(row[col.category] || '').trim() : '') || 'Menu',
        name,
        description: col.description ? String(row[col.description] || '').trim() : '',
        price,
        isVeg,
        image: col.image ? String(row[col.image] || '').trim() : '',
      });
    });

    if (!items.length) {
      return res.status(400).json({ error: 'No valid rows found in the CSV', errors });
    }

    const summary = { categoriesCreated: 0, itemsCreated: 0, itemsUpdated: 0, errors };

    await transaction(async () => {
      if (mode === 'replace') {
        // Clear the existing menu (categories + items) but keep tables/orders.
        await run('DELETE FROM menu_items WHERE tenant_id = ?', [tenantId]);
        await run('DELETE FROM menu_categories WHERE tenant_id = ?', [tenantId]);
      }

      // Existing categories, so we reuse them instead of creating duplicates.
      const existingCats = await query(
        'SELECT id, name FROM menu_categories WHERE tenant_id = ?',
        [tenantId]
      );
      const catByName = new Map(existingCats.map((c) => [c.name.toLowerCase(), c.id]));

      const maxCat = await get('SELECT MAX(sort_order) AS m FROM menu_categories WHERE tenant_id = ?', [tenantId]);
      let catSort = (maxCat.m || 0) + 1;
      const maxItem = await get('SELECT MAX(sort_order) AS m FROM menu_items WHERE tenant_id = ?', [tenantId]);
      let itemSort = (maxItem.m || 0) + 1;

      for (const it of items) {
        const key = it.category.toLowerCase();
        if (!catByName.has(key)) {
          const r = await run(
            'INSERT INTO menu_categories (tenant_id, name, sort_order) VALUES (?, ?, ?)',
            [tenantId, it.category, catSort++]
          );
          catByName.set(key, r.lastInsertRowid);
          summary.categoriesCreated++;
        }
        const categoryId = catByName.get(key);

        // If the same item name already exists in that category, update it.
        const dup = await get(
          'SELECT id FROM menu_items WHERE tenant_id = ? AND category_id = ? AND lower(name) = lower(?)',
          [tenantId, categoryId, it.name]
        );
        if (dup) {
          await run(
            `UPDATE menu_items SET description = ?, price = ?, is_veg = ?, image_url = ?,
                                   is_available = 1, sort_order = ? WHERE id = ?`,
            [it.description || null, it.price, it.isVeg ? 1 : 0, it.image || null, itemSort++, dup.id]
          );
          summary.itemsUpdated++;
        } else {
          await run(
            `INSERT INTO menu_items (tenant_id, category_id, name, description, price, image_url, is_veg, is_available, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [tenantId, categoryId, it.name, it.description || null, it.price, it.image || null, it.isVeg ? 1 : 0, itemSort++]
          );
          summary.itemsCreated++;
        }
      }
    });

    res.json({ ok: true, ...summary });
  } catch (err) {
    next(err);
  }
});

/** Find the first header key that exists in the row object. */
function find(row, candidates) {
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, c)) return c;
  }
  return null;
}

/* ------------------------------ helpers ------------------------------- */

async function ownedCategory(tenantId, id) {
  return get('SELECT * FROM menu_categories WHERE id = ? AND tenant_id = ?', [Number(id), tenantId]);
}
async function ownedItem(tenantId, id) {
  return get('SELECT * FROM menu_items WHERE id = ? AND tenant_id = ?', [Number(id), tenantId]);
}

module.exports = router;
