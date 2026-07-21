'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { amountCents, freeApplied, formatCents } = require('../lib/money');
const { computeLines, loadPricing, subtotalCents, totalCalls } = require('../lib/pricing');

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
