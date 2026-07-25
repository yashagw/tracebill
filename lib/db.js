// SQLite schema. One WAL database, shared by the gateway (key lookups) and the app.
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingest_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER            -- epoch ms after which the key is invalid (NULL = active)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES tenant_users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  external_id TEXT NOT NULL,
  display_name TEXT,
  quota_status TEXT NOT NULL DEFAULT 'ok',
  UNIQUE(tenant_id, external_id)
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  reconciliation TEXT NOT NULL DEFAULT 'pending' CHECK (reconciliation IN ('ok','warn','pending')),
  reconciliation_note TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, customer_id, period_start)
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit TEXT NOT NULL,
  unit_price_micros INTEGER NOT NULL,
  free_units_applied INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL,
  UNIQUE(invoice_id, sku)
);
CREATE TABLE IF NOT EXISTS receipts (
  invoice_line_id TEXT NOT NULL REFERENCES invoice_lines(id),
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  route TEXT,
  duration_ms REAL,
  status_code INTEGER,
  bytes INTEGER,
  PRIMARY KEY (invoice_line_id, span_id)
);
CREATE TABLE IF NOT EXISTS share_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  created_at INTEGER NOT NULL
);
`;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open };
