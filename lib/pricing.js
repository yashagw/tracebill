// pricing.yaml -> invoice lines. Pure functions; all money via lib/money.
'use strict';

const fs = require('fs');
const yaml = require('js-yaml');
const { amountCents, freeApplied } = require('./money');

function loadPricing(path) {
  const doc = yaml.load(fs.readFileSync(path, 'utf8')) || {};
  return doc.tenants || {};
}

function skuRule(tenantPricing, sku) {
  const skus = (tenantPricing && tenantPricing.skus) || {};
  return skus[sku] || skus.default || { unit_price_micros: 0, free_units: 0, description: 'API calls' };
}

/**
 * usage: [{customer, sku, calls, compute_ns, egress_bytes}] for one tenant+period.
 * Returns {customer: lines[]}. Call lines are per-SKU; compute and egress roll
 * up to one line each.
 */
function computeLines(tenantPricing, usage) {
  const byCustomer = new Map();
  for (const row of usage) {
    if (!byCustomer.has(row.customer)) byCustomer.set(row.customer, []);
    byCustomer.get(row.customer).push(row);
  }
  const out = {};
  for (const [customer, rows] of byCustomer) {
    const lines = [];
    let computeNs = 0n;
    let egressBytes = 0n;
    for (const r of rows.slice().sort((a, b) => (a.sku < b.sku ? -1 : 1))) {
      const rule = skuRule(tenantPricing, r.sku);
      const free = rule.free_units ?? 0;
      lines.push({
        sku: r.sku,
        description: rule.description || 'API calls',
        quantity: r.calls,
        unit: 'calls',
        unit_price_micros: rule.unit_price_micros ?? 0,
        free_units_applied: freeApplied(r.calls, free),
        amount_cents: amountCents({
          quantity: r.calls,
          freeUnits: free,
          unitPriceMicros: rule.unit_price_micros ?? 0,
        }),
      });
      computeNs += BigInt(Math.round(r.compute_ns || 0));
      egressBytes += BigInt(Math.round(r.egress_bytes || 0));
    }
    if (tenantPricing.compute && computeNs > 0n) {
      lines.push({
        sku: '_compute',
        description: tenantPricing.compute.description || 'Compute time',
        quantity: Number(computeNs), // nanoseconds; portal renders as seconds
        unit: 'ns',
        unit_price_micros: tenantPricing.compute.price_micros_per_second ?? 0,
        free_units_applied: 0,
        amount_cents: amountCents({
          quantity: computeNs,
          unitPriceMicros: tenantPricing.compute.price_micros_per_second ?? 0,
          unitScaleNum: 1n,
          unitScaleDen: 1000000000n, // priced per second, measured in ns
        }),
      });
    }
    if (tenantPricing.egress && egressBytes > 0n) {
      lines.push({
        sku: '_egress',
        description: tenantPricing.egress.description || 'Data egress',
        quantity: Number(egressBytes), // bytes; portal renders as KB/MB
        unit: 'bytes',
        unit_price_micros: tenantPricing.egress.price_micros_per_mb ?? 0,
        free_units_applied: 0,
        amount_cents: amountCents({
          quantity: egressBytes,
          unitPriceMicros: tenantPricing.egress.price_micros_per_mb ?? 0,
          unitScaleNum: 1n,
          unitScaleDen: 1000000n, // priced per MB (1e6 bytes)
        }),
      });
    }
    out[customer] = lines;
  }
  return out;
}

// Cost (micros) of a single span. Free tiers are per-period, so they are
// applied in computeLines rather than here.
function spanCostMicros(tenantPricing, { sku, durationNs = 0, bytes = 0 } = {}) {
  const rule = skuRule(tenantPricing, sku);
  const call = Math.max(0, Math.round(rule.unit_price_micros ?? 0));
  const compute = tenantPricing && tenantPricing.compute
    ? Math.max(0, Math.round((durationNs / 1e9) * (tenantPricing.compute.price_micros_per_second ?? 0)))
    : 0;
  const egress = tenantPricing && tenantPricing.egress
    ? Math.max(0, Math.round((bytes / 1e6) * (tenantPricing.egress.price_micros_per_mb ?? 0)))
    : 0;
  return { call, compute, egress, total: call + compute + egress };
}

function subtotalCents(lines) {
  return lines.reduce((s, l) => s + l.amount_cents, 0);
}

/** total calls across call lines (for quota + reconciliation) */
function totalCalls(lines) {
  return lines.filter((l) => l.unit === 'calls').reduce((s, l) => s + l.quantity, 0);
}

module.exports = { loadPricing, skuRule, computeLines, spanCostMicros, subtotalCents, totalCalls };
