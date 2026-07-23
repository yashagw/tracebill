'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { open } = require('../lib/db');
const { Engine, ClosedInvoiceError } = require('../engine/engine');
const { SignozClient } = require('../engine/signoz');
const { shareTokenFor } = require('../app/server');

const PRICING = path.join(__dirname, 'fixtures-pricing.yaml');

function freshEngine(usageRows, spanRows) {
  const dbPath = path.join(os.tmpdir(), `tb-eng-${Date.now()}-${Math.random()}.db`);
  const db = open(dbPath);
  db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run('tn1', 'T1', Date.now());
  const fakeSignoz = {
    usageAggregate: async () => usageRows,
    billableSpans: async () => spanRows,
  };
  const engine = new Engine({ db, signoz: fakeSignoz, pricingPath: PRICING, periodMinutes: 5, closeGraceMs: 0 });
  return { db, engine, dbPath, fakeSignoz };
}

test.before(() => {
  fs.writeFileSync(
    PRICING,
    `tenants:\n  tn1:\n    skus:\n      "get./x": {unit_price_micros: 10000, free_units: 2}\n      default: {unit_price_micros: 1000, free_units: 0}\n    quota: {calls_per_period: 100}\n`
  );
});
test.after(() => fs.rmSync(PRICING, { force: true }));

const usage = [{ customer: 'acme', sku: 'get./x', calls: 5, compute_ns: 0, egress_bytes: 0 }];
const spans = [
  { customer: 'acme', sku: 'get./x', trace_id: 't1', span_id: 's1', ts: 1, route: '/x', duration_ms: 1, status_code: 200, bytes: 10 },
  { customer: 'acme', sku: 'get./x', trace_id: 't2', span_id: 's2', ts: 2, route: '/x', duration_ms: 1, status_code: 200, bytes: 10 },
];

test('invoice idempotency: repeated metering -> one invoice, same id, stable lines', async () => {
  const { db, engine } = freshEngine(usage, spans);
  const period = engine.periodFor(Date.now());
  await engine.meterTenantPeriod('tn1', period);
  const inv1 = db.prepare('SELECT * FROM invoices').all();
  assert.strictEqual(inv1.length, 1);
  await engine.meterTenantPeriod('tn1', period);
  await engine.meterTenantPeriod('tn1', period);
  const inv2 = db.prepare('SELECT * FROM invoices').all();
  assert.strictEqual(inv2.length, 1);
  assert.strictEqual(inv2[0].id, inv1[0].id);
  const lines = db.prepare('SELECT * FROM invoice_lines').all();
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(Number(lines[0].quantity), 5);
  assert.strictEqual(Number(lines[0].amount_cents), 3); // (5-2 free) * $0.01
});

test('receipts dedupe on (line, span_id) across repeated pulls', async () => {
  const { db, engine } = freshEngine(usage, spans);
  const period = engine.periodFor(Date.now());
  await engine.meterTenantPeriod('tn1', period);
  await engine.meterTenantPeriod('tn1', period); // same spans pulled again
  const receipts = db.prepare('SELECT * FROM receipts').all();
  assert.strictEqual(receipts.length, 2, 'no duplicates despite double pull');
});

test('closed invoices are immutable: writes blocked, late spans ignored', async () => {
  const { db, engine } = freshEngine(usage, spans);
  const period = engine.periodFor(Date.now() - 10 * 60 * 1000); // an already-past period
  await engine.meterTenantPeriod('tn1', period);
  await engine.closeDuePeriods(Date.now());
  const inv = db.prepare('SELECT * FROM invoices').get();
  assert.strictEqual(inv.status, 'closed');
  const before = JSON.stringify(db.prepare('SELECT * FROM invoice_lines').all());
  const subtotalBefore = inv.subtotal_cents;

  // direct write path throws
  assert.throws(() => engine.writeLines(inv, []), ClosedInvoiceError);

  // late telemetry for the same period: meter pass must skip the closed invoice
  const moreUsage = [{ customer: 'acme', sku: 'get./x', calls: 50, compute_ns: 0, egress_bytes: 0 }];
  const e2 = new Engine({ db, signoz: { usageAggregate: async () => moreUsage, billableSpans: async () => [] }, pricingPath: PRICING, periodMinutes: 5, closeGraceMs: 0 });
  await e2.meterTenantPeriod('tn1', period);
  const after = db.prepare('SELECT * FROM invoices').get();
  assert.strictEqual(after.status, 'closed');
  assert.strictEqual(after.subtotal_cents, subtotalBefore);
  assert.strictEqual(JSON.stringify(db.prepare('SELECT * FROM invoice_lines').all()), before);
});

test('reconciliation: ok when receipts == metered, warn with delta otherwise', async () => {
  // metered 5 calls but only 2 receipts resolvable -> warn "3 records unverifiable"
  const { db, engine } = freshEngine(usage, spans);
  const period = engine.periodFor(Date.now() - 10 * 60 * 1000);
  await engine.meterTenantPeriod('tn1', period);
  await engine.closeDuePeriods(Date.now());
  const inv = db.prepare('SELECT * FROM invoices').get();
  assert.strictEqual(inv.reconciliation, 'warn');
  assert.match(inv.reconciliation_note, /3 records unverifiable/);

  // exact receipts -> ok
  const fullSpans = Array.from({ length: 5 }, (_, i) => ({
    customer: 'acme', sku: 'get./x', trace_id: `t${i}`, span_id: `s${i}`, ts: i, route: '/x', duration_ms: 1, status_code: 200, bytes: 1,
  }));
  const { db: db2, engine: e2 } = freshEngine(usage, fullSpans);
  await e2.meterTenantPeriod('tn1', period);
  await e2.closeDuePeriods(Date.now());
  const inv2 = db2.prepare('SELECT * FROM invoices').get();
  assert.strictEqual(inv2.reconciliation, 'ok');
});

test('quota flag set when calls exceed quota', async () => {
  const heavy = [{ customer: 'acme', sku: 'get./x', calls: 101, compute_ns: 0, egress_bytes: 0 }];
  const { db, engine } = freshEngine(heavy, []);
  await engine.meterTenantPeriod('tn1', engine.periodFor(Date.now()));
  assert.strictEqual(db.prepare('SELECT quota_status FROM customers').get().quota_status, 'over');
});

test('share tokens are deterministic per invoice (idempotent) and scoped', () => {
  const a = shareTokenFor('inv_1', 'secret');
  assert.strictEqual(a, shareTokenFor('inv_1', 'secret'), 'same invoice -> same token');
  assert.notStrictEqual(a, shareTokenFor('inv_2', 'secret'), 'different invoice -> different token');
  assert.notStrictEqual(a, shareTokenFor('inv_1', 'other'), 'secret-dependent');
  assert.match(a, /^shr_[0-9a-f]{22}$/);
});

test('trace scoping: tenant mismatch and customer mismatch both reject; tags never leak', () => {
  const sz = new SignozClient({ baseUrl: 'http://unused', pat: 'x' });
  const spans = [
    { span_id: 'a', parent_id: null, name: 'GET /x', service: 's', kind: 'Server', start_ms: 1, duration_ns: 10, error: false, tags: { 'tracebill.tenant_id': 'tn1', 'billing.customer_id': 'acme' } },
    { span_id: 'b', parent_id: 'a', name: 'db', service: 's', kind: 'Internal', start_ms: 2, duration_ns: 5, error: false, tags: { 'tracebill.tenant_id': 'tn1' } },
  ];
  const ok = sz.scopeTrace(spans, 'tn1');
  assert.strictEqual(ok.length, 2);
  assert.strictEqual(ok[0].tags, undefined, 'raw attributes are stripped before serving');
  assert.strictEqual(sz.scopeTrace(spans, 'tn2'), null, 'other tenant -> null (404)');
  assert.strictEqual(sz.scopeTrace(spans, 'tn1', 'acme').length, 2, 'right customer ok');
  assert.strictEqual(sz.scopeTrace(spans, 'tn1', 'globex'), null, 'other customer -> null (404)');
  // one span missing the tenant attribute rejects the whole trace
  const mixed = [...spans, { span_id: 'c', parent_id: 'a', name: 'x', tags: {} }];
  assert.strictEqual(sz.scopeTrace(mixed, 'tn1'), null);
  assert.strictEqual(sz.scopeTrace([], 'tn1'), null);
  assert.strictEqual(sz.scopeTrace(null, 'tn1'), null);
});
