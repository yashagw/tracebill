// Astro Store: a plain Express API standing in for a TraceBill customer.
// The whole integration is the tracebill.init() call below.
'use strict';

// demo/.env is written by npm run seed.
const fs = require('fs');
const path = require('path');
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

// Astro Store's own API keys. Any per-request signal works here.
const API_KEYS = { ak_acme_1: 'acme', ak_globex_1: 'globex', ak_initech_1: 'initech' };

const tracebill = require('@tracebill/node');
tracebill.init({
  key: process.env.TRACEBILL_KEY,
  serviceName: 'astro-store-api',
  identify: (req) => API_KEYS[req.headers['x-api-key']], // who to bill for this request
});

const express = require('express');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || process.env.DEMO_PORT || 3002;

const PRODUCTS = [
  { id: 1, name: 'OTel Hoodie', price: 49, stock: 12 },
  { id: 2, name: 'Nebula Mug', price: 14, stock: 40 },
  { id: 3, name: 'Flame Graph Poster', price: 21, stock: 7 },
  { id: 4, name: 'Traceparent T-Shirt', price: 25, stock: 18 },
  { id: 5, name: 'P99 Sticker Pack', price: 6, stock: 100 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('astro-store');

/** A manual span around the fake query, so waterfalls have some depth. */
async function dbQuery(operation, statement, delayMs) {
  return tracer.startActiveSpan(`db.query ${operation}`, async (span) => {
    span.setAttribute('db.system', 'memdb');
    span.setAttribute('db.operation', operation);
    span.setAttribute('db.statement', statement);
    try {
      await sleep(delayMs);
      return PRODUCTS;
    } finally {
      span.end();
    }
  });
}

app.get('/api/products', async (req, res) => {
  const rows = await dbQuery('SELECT', 'SELECT * FROM products', 20 + Math.random() * 40);
  res.json({ products: rows });
});

app.get('/api/slow', async (req, res) => {
  const rows = await dbQuery('SELECT', 'SELECT * FROM products ORDER BY RANDOM()', 900 + Math.random() * 600);
  res.json({ products: rows, warning: 'bulk export completed' });
});

app.post('/api/checkout', async (req, res) => {
  await dbQuery('UPDATE', 'UPDATE products SET stock = stock - 1 WHERE id = $1', 40 + Math.random() * 40);
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[astro-store] listening on http://localhost:${PORT}`);
});
