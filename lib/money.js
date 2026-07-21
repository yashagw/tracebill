// Unit prices are integer micro-dollars (1e-6 USD); line amounts are integer
// cents. BigInt throughout, with exactly one round-half-up per line.
'use strict';

const MICROS_PER_CENT = 10000n;

/** round-half-up division for non-negative BigInts */
function divRoundHalfUp(num, den) {
  return (num + den / 2n) / den;
}

/**
 * Amount in cents for `billableUnits` at `unitPriceMicros` per unit,
 * where each unit may itself be a fraction of the priced unit expressed as
 * unitScaleNum/unitScaleDen (e.g. nanoseconds priced per second: 1/1e9).
 */
function amountCents({ quantity, freeUnits = 0, unitPriceMicros, unitScaleNum = 1n, unitScaleDen = 1n }) {
  const q = BigInt(quantity);
  const free = BigInt(freeUnits);
  const billable = q > free ? q - free : 0n;
  const micros = billable * BigInt(unitPriceMicros) * BigInt(unitScaleNum);
  const cents = divRoundHalfUp(micros, MICROS_PER_CENT * BigInt(unitScaleDen));
  return Number(cents);
}

/** free units actually applied to a quantity */
function freeApplied(quantity, freeUnits) {
  const q = BigInt(quantity);
  const f = BigInt(freeUnits ?? 0);
  return Number(q < f ? q : f);
}

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

module.exports = { amountCents, freeApplied, formatCents, divRoundHalfUp };
