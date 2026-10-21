'use strict';

/**
 * Order lifecycle. `next` defines which transitions are allowed so kitchen /
 * cashier UIs can show the right button and the API can reject invalid jumps.
 */

const ORDER_STATUS = {
  PLACED: 'placed',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  PAID: 'paid',
  CANCELLED: 'cancelled',
};

// Human labels (used by both kitchen/cashier UI and customer status screen).
const STATUS_LABEL = {
  placed: 'Order Placed',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

// Customer-facing progress steps (cancelled orders show separately).
const CUSTOMER_FLOW = ['placed', 'accepted', 'preparing', 'ready', 'served'];

// Allowed transitions -> next statuses.
const TRANSITIONS = {
  placed: ['accepted', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served'],
  served: ['paid'],
  paid: [],
  cancelled: [],
};

// Which role is allowed to perform a given transition.
const TRANSITION_ROLE = {
  'placed>accepted': 'kitchen',
  'accepted>preparing': 'kitchen',
  'preparing>ready': 'kitchen',
  'ready>served': 'cashier',   // waiter/cashier confirms it reached the table
  'served>paid': 'cashier',    // cash counter collects payment
  'placed>cancelled': 'owner',
  'accepted>cancelled': 'owner',
  'preparing>cancelled': 'owner',
};

// Statuses that still count as "open" on the kitchen / cashier boards.
const OPEN_STATUSES = ['placed', 'accepted', 'preparing', 'ready'];

module.exports = {
  ORDER_STATUS,
  STATUS_LABEL,
  CUSTOMER_FLOW,
  TRANSITIONS,
  TRANSITION_ROLE,
  OPEN_STATUSES,
};
