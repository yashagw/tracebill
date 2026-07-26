'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { amountCents, freeApplied, formatCents } = require('../lib/money');
const { computeLines, loadPricing, subtotalCents, totalCalls, resolvePricing, quotaFor } = require('../lib/pricing');

test('amountCents: basic unit pricing, integer only', () => {
  // 30 calls at $0.002 = $0.06
  assert.strictEqual(amountCents({ quantity: 30, unitPriceMicros: 2000 }), 6);
  // 6 calls at $0.02 = $0.12
  assert.strictEqual(amountCents({ quantity: 6, unitPriceMicros: 20000 }), 12);
});

test('amountCents: free tier boundary', () => {
  assert.strictEqual(amountCents({ quantity: 25, freeUnits: 25, unitPriceMicros: 2000 }), 0);
  assert.strictEqual(amountCents({ quantity: 26, freeUnits: 25, unitPriceMicros: 2000 }), 0); // 1 * $0.002 rounds to 0 cents
  assert.strictEqual(amountCents({ quantity: 24, freeUnits: 25, unitPriceMicros: 2000 }), 0);
  assert.strictEqual(amountCents({ quantity: 1025, freeUnits: 25, unitPriceMicros: 2000 }), 200); // 1000 * $0.002 = $2.00
});

test('amountCents: round half-up exactly once per line', () => {
  // 3 calls at 1667 micros = 5001 micros = 0.5001 cents -> 1 cent (half-up)
  assert.strictEqual(amountCents({ quantity: 3, unitPriceMicros: 1667 }), 1);
  // 0.4999 cents -> 0
  assert.strictEqual(amountCents({ quantity: 1, unitPriceMicros: 4999 }), 0);
  // exactly half a cent -> up
  assert.strictEqual(amountCents({ quantity: 1, unitPriceMicros: 5000 }), 1);
});

test('amountCents: scaled units (compute ns priced per second, egress bytes per MB)', () => {
  // 1.5e9 ns at $0.03/s = $0.045 -> 5 cents (half-up from 4.5)
  assert.strictEqual(
    amountCents({ quantity: 1500000000n, unitPriceMicros: 30000, unitScaleDen: 1000000000n }),
    5
  );
  // 2,000,000 bytes at $0.09/MB = $0.18
  assert.strictEqual(
    amountCents({ quantity: 2000000n, unitPriceMicros: 90000, unitScaleDen: 1000000n }),
    18
  );
  // huge values stay exact under BigInt: 10^15 ns (11.5 days) at $0.03/s = $30,000.00
  assert.strictEqual(
    amountCents({ quantity: 10n ** 15n, unitPriceMicros: 30000, unitScaleDen: 1000000000n }),
    3000000
  );
});

test('freeApplied caps at quantity', () => {
  assert.strictEqual(freeApplied(10, 25), 10);
  assert.strictEqual(freeApplied(30, 25), 25);
  assert.strictEqual(freeApplied(30, 0), 0);
});

test('formatCents', () => {
  assert.strictEqual(formatCents(16), '$0.16');
  assert.strictEqual(formatCents(120050), '$1200.50');
});

test('computeLines: per-sku pricing + default fallback + compute/egress rollup', () => {
  const pricing = {
    skus: {
      'get./api/products': { description: 'reads', unit_price_micros: 2000, free_units: 25 },
      default: { description: 'API calls', unit_price_micros: 1000, free_units: 0 },
    },
    compute: { price_micros_per_second: 30000 },
    egress: { price_micros_per_mb: 90000 },
  };
  const usage = [
    { customer: 'acme', sku: 'get./api/products', calls: 30, compute_ns: 5e8, egress_bytes: 1000 },
    { customer: 'acme', sku: 'post./api/unpriced', calls: 10, compute_ns: 5e8, egress_bytes: 500 },
    { customer: 'globex', sku: 'get./api/products', calls: 10, compute_ns: 1e9, egress_bytes: 0 },
  ];
  const out = computeLines(pricing, usage);
  const acme = out.acme;
  const products = acme.find((l) => l.sku === 'get./api/products');
  assert.strictEqual(products.quantity, 30);
  assert.strictEqual(products.free_units_applied, 25);
  assert.strictEqual(products.amount_cents, 1); // 5 * $0.002 = $0.01
  const unpriced = acme.find((l) => l.sku === 'post./api/unpriced');
  assert.strictEqual(unpriced.unit_price_micros, 1000); // default rule
  assert.strictEqual(unpriced.amount_cents, 1);
  const compute = acme.find((l) => l.sku === '_compute');
  assert.strictEqual(compute.quantity, 1e9); // ns summed across skus
  assert.strictEqual(compute.amount_cents, 3); // 1s * $0.03
  const egress = acme.find((l) => l.sku === '_egress');
  assert.strictEqual(egress.quantity, 1500);
  assert.strictEqual(totalCalls(acme), 40);
  // globex fully inside free tier, still gets a zero-amount line (not hidden)
  const globex = out.globex;
  assert.strictEqual(globex.find((l) => l.sku === 'get./api/products').amount_cents, 0);
  assert.strictEqual(subtotalCents(acme), products.amount_cents + unpriced.amount_cents + compute.amount_cents + egress.amount_cents);
});

test('computeLines is deterministic (per-period reset: same usage in, same lines out)', () => {
  const pricing = { skus: { default: { unit_price_micros: 1500, free_units: 2 } } };
  const usage = [{ customer: 'c1', sku: 'get./x', calls: 7, compute_ns: 0, egress_bytes: 0 }];
  const a = JSON.stringify(computeLines(pricing, usage));
  const b = JSON.stringify(computeLines(pricing, usage));
  assert.strictEqual(a, b);
});

test('pricing.yaml parses and covers the demo tenant', () => {
  const p = loadPricing(path.join(__dirname, '..', 'pricing.yaml'));
  assert.ok(p['astro-store']);
  assert.ok(p['astro-store'].skus['get./api/products'].unit_price_micros > 0);
  assert.ok(Number.isInteger(p['astro-store'].skus['get./api/products'].unit_price_micros));
});

// ---------- per-customer contracts ----------

const CONTRACTS = {
  skus: {
    'get./x': { description: 'Reads', unit_price_micros: 2000, free_units: 25 },
    'post./y': { description: 'Writes', unit_price_micros: 20000, free_units: 0 },
    default: { description: 'API calls', unit_price_micros: 1000, free_units: 0 },
  },
  compute: { price_micros_per_second: 30000 },
  egress: { price_micros_per_mb: 90000 },
  quota: { calls_per_period: 400 },
  customers: {
    big: {
      skus: { 'get./x': { description: 'Reads (enterprise)', unit_price_micros: 1200, free_units: 100 } },
      compute: { price_micros_per_second: 20000 },
      quota: { calls_per_period: 20 },
    },
  },
};

test('resolvePricing: a contract overrides only what it names', () => {
  const big = resolvePricing(CONTRACTS, 'big');
  // repriced
  assert.strictEqual(big.skus['get./x'].unit_price_micros, 1200);
  assert.strictEqual(big.skus['get./x'].free_units, 100);
  assert.strictEqual(big.compute.price_micros_per_second, 20000);
  assert.strictEqual(quotaFor(big), 20);
  // inherited from the tenant default price book
  assert.strictEqual(big.skus['post./y'].unit_price_micros, 20000);
  assert.strictEqual(big.skus.default.unit_price_micros, 1000);
  assert.strictEqual(big.egress.price_micros_per_mb, 90000);
  // the contract list itself never leaks into a resolved book
  assert.strictEqual(big.customers, undefined);
});

test('resolvePricing: a customer with no contract gets tenant defaults', () => {
  const small = resolvePricing(CONTRACTS, 'small');
  assert.strictEqual(small.skus['get./x'].unit_price_micros, 2000);
  assert.strictEqual(small.compute.price_micros_per_second, 30000);
  assert.strictEqual(quotaFor(small), 400);
});

test('resolvePricing: the older quota.per_customer shape still applies', () => {
  const legacy = { skus: { default: { unit_price_micros: 1000 } }, quota: { calls_per_period: 400, per_customer: { acme: 20 } } };
  assert.strictEqual(quotaFor(resolvePricing(legacy, 'acme')), 20);
  assert.strictEqual(quotaFor(resolvePricing(legacy, 'other')), 400);
  // and a real contract wins over it
  const both = { ...legacy, customers: { acme: { quota: { calls_per_period: 50 } } } };
  assert.strictEqual(quotaFor(resolvePricing(both, 'acme')), 50);
  // per_customer is an input, never part of a resolved book
  assert.strictEqual(resolvePricing(legacy, 'acme').quota.per_customer, undefined);
});

test('computeLines bills each customer against their own contract', () => {
  const usage = [
    { customer: 'big', sku: 'get./x', calls: 200, compute_ns: 1000000000, egress_bytes: 0 },
    { customer: 'small', sku: 'get./x', calls: 200, compute_ns: 1000000000, egress_bytes: 0 },
  ];
  const lines = computeLines(CONTRACTS, usage);

  // big: 200 calls, 100 free -> 100 * $0.0012 = $0.12
  const bigCall = lines.big.find((l) => l.sku === 'get./x');
  assert.strictEqual(bigCall.unit_price_micros, 1200);
  assert.strictEqual(bigCall.free_units_applied, 100);
  assert.strictEqual(bigCall.amount_cents, 12);

  // small: 200 calls, 25 free -> 175 * $0.002 = $0.35
  const smallCall = lines.small.find((l) => l.sku === 'get./x');
  assert.strictEqual(smallCall.unit_price_micros, 2000);
  assert.strictEqual(smallCall.free_units_applied, 25);
  assert.strictEqual(smallCall.amount_cents, 35);

  // same second of compute, different negotiated rate
  assert.strictEqual(lines.big.find((l) => l.sku === '_compute').amount_cents, 2);
  assert.strictEqual(lines.small.find((l) => l.sku === '_compute').amount_cents, 3);
});

test('demo pricing.yaml gives acme a contract and leaves globex on defaults', () => {
  const tenant = loadPricing(path.join(__dirname, '..', 'pricing.yaml'))['astro-store'];
  const acme = resolvePricing(tenant, 'acme');
  const globex = resolvePricing(tenant, 'globex');
  assert.ok(acme.skus['get./api/products'].unit_price_micros < globex.skus['get./api/products'].unit_price_micros);
  assert.ok(quotaFor(acme) < quotaFor(globex));
  assert.strictEqual(
    globex.skus['get./api/products'].unit_price_micros,
    tenant.skus['get./api/products'].unit_price_micros
  );
});
