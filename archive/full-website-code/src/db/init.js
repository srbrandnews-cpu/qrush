'use strict';

const fs = require('fs');
const path = require('path');
const { exec, dialect } = require('../config/db');

/**
 * Create tables if they do not exist yet. Safe to call on every boot.
 * Picks the schema that matches the active driver (sqlite vs postgres).
 */
async function ensureSchema() {
  const file = dialect() === 'postgres' ? 'schema.postgres.sql' : 'schema.sql';
  const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
  await exec(sql);
}

module.exports = { ensureSchema };
