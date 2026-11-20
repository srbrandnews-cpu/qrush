'use strict';

const express = require('express');
const { get } = require('../config/db');
const push = require('../services/push');

const router = express.Router();

/**
 * GET /api/push/vapid-public-key  (public — the menu page fetches this)
 */
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.publicKey() });
});

/**
 * POST /api/push/subscribe  { table, deviceId, subscription }
 * Called by the customer's phone after they tap "Enable notifications".
 */
router.post('/subscribe', async (req, res, next) => {
  try {
    const { table, deviceId, subscription } = req.body || {};
    if (!table || !deviceId || !subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'table, deviceId and subscription are required' });
    }
    const t = await get(
      `SELECT t.tenant_id FROM tables t JOIN tenants tn ON tn.id = t.tenant_id
        WHERE t.qr_token = ? AND t.is_active = 1 AND tn.is_active = 1`,
      [String(table)]
    );
    if (!t) return res.status(404).json({ error: 'Invalid table' });

    await push.saveSubscription(t.tenant_id, String(deviceId), subscription);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/push/unsubscribe  { endpoint }
 */
router.post('/unsubscribe', async (req, res, next) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (endpoint) await push.removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
