'use strict';

const { Server } = require('socket.io');
const { verifyToken } = require('../middleware/auth');
const { get } = require('../config/db');

let io = null;

/**
 * Socket rooms:
 *   - `tenant:{tenantId}`                  -> kitchen / cashier / owner screens
 *   - `table:{tenantId}:{tableToken}`      -> a customer's phone on a table
 *
 * Staff authenticate with a JWT; customers only need a valid table token
 * (they are anonymous by design).
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });

  io.on('connection', async (socket) => {
    const q = socket.handshake.query || {};
    const auth = socket.handshake.auth || {};

    // ---- Staff screen (kitchen / cashier / owner) ----
    if (auth.token) {
      const user = verifyToken(auth.token);
      if (!user) {
        // Expired or tampered token — tell the client to log in again.
        socket.emit('unauthorized', { reason: 'Session expire ho gaya' });
        socket.disconnect(true);
        return;
      }
      socket.data.role = user.role;
      socket.data.tenantId = user.tenantId;
      socket.join(`tenant:${user.tenantId}`);
      socket.emit('ready', { role: user.role });
      return;
    }

    // ---- Customer phone (anonymous, table-scoped) ----
    if (q.tableToken) {
      const table = await get('SELECT id, tenant_id, name FROM tables WHERE qr_token = ? AND is_active = 1', [q.tableToken]).catch(() => null);
      if (!table) {
        socket.emit('error', { message: 'Invalid table' });
        socket.disconnect(true);
        return;
      }
      socket.data.tableId = table.id;
      socket.data.tenantId = table.tenant_id;
      socket.data.tableToken = q.tableToken;
      socket.join(`table:${table.tenant_id}:${q.tableToken}`);
      socket.emit('ready', { table: table.name });
      return;
    }

    socket.disconnect(true);
  });

  return io;
}

function getIO() {
  return io;
}

/**
 * Push an order update to the owning restaurant AND the customer's table.
 */
function emitOrderUpdate(order) {
  if (!io || !order) return;
  const payload = { order };
  io.to(`tenant:${order.tenant_id}`).emit('order:update', payload);
  if (order.table_token) {
    io.to(`table:${order.tenant_id}:${order.table_token}`).emit('order:update', payload);
  }
}

function emitToTenant(tenantId, event, payload) {
  if (!io) return;
  io.to(`tenant:${tenantId}`).emit(event, payload);
}

module.exports = { initSocket, getIO, emitOrderUpdate, emitToTenant };
