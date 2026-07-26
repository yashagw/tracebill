// pricing.yaml -> invoice lines. Pure functions; all money via lib/money.
'use strict';

const fs = require('fs');
const yaml = require('js-yaml');
const { amountCents, freeApplied } = require('./money');

function loadPricing(path) {
  const doc = yaml.load(fs.readFileSync(path, 'utf8')) || {};
  return doc.tenants || {};
}

function skuRule(pricing, sku) {
  const skus = (pricing && pricing.skus) || {};
  return skus[sku] || skus.default || { unit_price_micros: 0, free_units: 0, description: 'API calls' };
}

/**
 * The rules that apply to one customer: their contract under `customers.<id>`
 * layered over the tenant's default price book. SKUs merge key by key, so a
 * contract can reprice one endpoint and inherit the rest; compute, egress and
 * currency replace wholesale when the contract names them.
 *
 * Customers without a contract get the tenant defaults unchanged.
 */
function resolvePricing(tenantPricing, customerExternalId) {
  const base = tenantPricing || {};
  const contract = (base.customers && base.customers[customerExternalId]) || null;
  // Older shape, still honoured: quota.per_customer.<id> as a bare call limit.
  const legacyQuota = base.quota && base.quota.per_customer && base.quota.per_customer[customerExternalId];
  if (!contract && legacyQuota === undefined) return base;

  const resolved = {
    ...base,
    ...(contract || {}),
    skus: { ...(base.skus || {}), ...((contract && contract.skus) || {}) },
    quota: { ...(base.quota || {}), ...((contract && contract.quota) || {}) },
  };
  const contractSetsQuota = contract && contract.quota && contract.quota.calls_per_period !== undefined;
  if (legacyQuota !== undefined && !contractSetsQuota) resolved.quota.calls_per_period = legacyQuota;
  delete resolved.quota.per_customer;
  delete resolved.customers;
  return resolved;
}

/** Call limit for an already-resolved price book, or null if uncapped. */
function quotaFor(pricing) {
  return ((pricing && pricing.quota) || {}).calls_per_period ?? null;
}

/**
 * usage: [{customer, sku, calls, compute_ns, egress_bytes}] for one tenant+period.
 * Returns {customer: lines[]}. Call lines are per-SKU; compute and egress roll
 * up to one line each. Each customer is priced against their own contract.
 */
function computeLines(tenantPricing, usage) {
  const byCustomer = new Map();
  for (const row of usage) {
    if (!byCustomer.has(row.customer)) byCustomer.set(row.customer, []);
    byCustomer.get(row.customer).push(row);
  }
  const out = {};
  for (const [customer, rows] of byCustomer) {
    const pricing = resolvePricing(tenantPricing, customer);
    const lines = [];
    let computeNs = 0n;
    let egressBytes = 0n;
    for (const r of rows.slice().sort((a, b) => (a.sku < b.sku ? -1 : 1))) {
      const rule = skuRule(pricing, r.sku);
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
    if (pricing.compute && computeNs > 0n) {
      lines.push({
        sku: '_compute',
        description: pricing.compute.description || 'Compute time',
        quantity: Number(computeNs), // nanoseconds; portal renders as seconds
        unit: 'ns',
        unit_price_micros: pricing.compute.price_micros_per_second ?? 0,
        free_units_applied: 0,
        amount_cents: amountCents({
          quantity: computeNs,
          unitPriceMicros: pricing.compute.price_micros_per_second ?? 0,
          unitScaleNum: 1n,
          unitScaleDen: 1000000000n, // priced per second, measured in ns
        }),
      });
    }
    if (pricing.egress && egressBytes > 0n) {
      lines.push({
        sku: '_egress',
        description: pricing.egress.description || 'Data egress',
        quantity: Number(egressBytes), // bytes; portal renders as KB/MB
        unit: 'bytes',
        unit_price_micros: pricing.egress.price_micros_per_mb ?? 0,
        free_units_applied: 0,
        amount_cents: amountCents({
          quantity: egressBytes,
          unitPriceMicros: pricing.egress.price_micros_per_mb ?? 0,
          unitScaleNum: 1n,
          unitScaleDen: 1000000n, // priced per MB (1e6 bytes)
        }),
      });
    }
    out[customer] = lines;
  }
  return out;
}

// Cost (micros) of a single span, against an already-resolved price book (see
// resolvePricing). Free tiers are per-period, so computeLines applies those.
function spanCostMicros(pricing, { sku, durationNs = 0, bytes = 0 } = {}) {
  const rule = skuRule(pricing, sku);
  const call = Math.max(0, Math.round(rule.unit_price_micros ?? 0));
  const compute = pricing && pricing.compute
    ? Math.max(0, Math.round((durationNs / 1e9) * (pricing.compute.price_micros_per_second ?? 0)))
    : 0;
  const egress = pricing && pricing.egress
    ? Math.max(0, Math.round((bytes / 1e6) * (pricing.egress.price_micros_per_mb ?? 0)))
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

module.exports = { loadPricing, resolvePricing, quotaFor, computeLines, spanCostMicros, subtotalCents, totalCalls };
