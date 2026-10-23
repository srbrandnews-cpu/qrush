'use strict';

/**
 * Per-request context.
 *
 * Some helpers (QR code generation) need to build absolute URLs. Instead of
 * relying on a hard-coded BASE_URL that has to be updated every time the app
 * moves to a new hostname, they can fall back to the origin of the request
 * that is currently being served.
 *
 * AsyncLocalStorage keeps this safe under concurrency: two simultaneous
 * requests each see their own origin.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Run `fn` with `origin` (e.g. "https://order.myhotel.in") visible to helpers. */
function runWithOrigin(origin, fn) {
  return als.run({ origin }, fn);
}

/** The origin of the request currently being handled, or undefined outside one. */
function currentOrigin() {
  const store = als.getStore();
  return store ? store.origin : undefined;
}

module.exports = { runWithOrigin, currentOrigin };
