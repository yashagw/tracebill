'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { deriveSku, normalizePath } = require('../sdk/sku');

test('sku derivation: method lowercased, route preserved', () => {
  assert.strictEqual(deriveSku('GET', '/api/products'), 'get./api/products');
  assert.strictEqual(deriveSku('POST', '/api/checkout'), 'post./api/checkout');
});

test('path normalization: ids collapse, query stripped', () => {
  assert.strictEqual(normalizePath('/api/orders/12345'), '/api/orders/:id');
  assert.strictEqual(normalizePath('/api/orders/550e8400-e29b-41d4-a716-446655440000'), '/api/orders/:id');
  assert.strictEqual(normalizePath('/api/t/deadbeefdeadbeef01'), '/api/t/:id');
  assert.strictEqual(normalizePath('/api/products?page=2'), '/api/products');
  assert.strictEqual(normalizePath('/api/products/'), '/api/products');
  assert.strictEqual(normalizePath(''), '/');
  assert.strictEqual(normalizePath('/'), '/');
});

test('sku is stable for equivalent requests (billing exactness prerequisite)', () => {
  assert.strictEqual(deriveSku('get', '/api/orders/1'), deriveSku('GET', '/api/orders/999?x=1'));
});
