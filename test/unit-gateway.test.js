'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { stampJson, stampProtobuf, decodeProtobuf, encodeProtobuf, TENANT_KEY } = require('../gateway/stamp');
const { KeyAuth } = require('../gateway/keys');
const { open } = require('../lib/db');
const { sha256, newIngestKey } = require('../lib/ids');

const attrsOf = (rs) => rs.resource.attributes;
const tenantOf = (rs) => attrsOf(rs).filter((a) => a.key === TENANT_KEY);

test('JSON stamping: every resource stamped, spoofed tenant_id overwritten', () => {
  const payload = {
    resourceSpans: [
      { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'a' } }, { key: TENANT_KEY, value: { stringValue: 'SPOOFED' } }] }, scopeSpans: [] },
      { resource: { attributes: [] }, scopeSpans: [] },
      { scopeSpans: [] }, // resource missing entirely
    ],
  };
  const out = stampJson(payload, 'tn_real');
  for (const rs of out.resourceSpans) {
    const t = tenantOf(rs);
    assert.strictEqual(t.length, 1, 'exactly one tenant attribute');
    assert.strictEqual(t[0].value.stringValue, 'tn_real');
  }
  // pre-existing attributes preserved
  assert.ok(attrsOf(out.resourceSpans[0]).some((a) => a.key === 'service.name'));
});

test('protobuf stamping: round-trip preserves spans and stamps every resource', () => {
  const obj = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc-a' } }, { key: TENANT_KEY, value: { stringValue: 'SPOOFED' } }] },
        scopeSpans: [
          {
            scope: { name: 'lib', version: '1' },
            spans: [
              {
                traceId: Buffer.alloc(16, 7),
                spanId: Buffer.alloc(8, 8),
                name: 'GET /x',
                kind: 2,
                startTimeUnixNano: 1000,
                endTimeUnixNano: 2000,
                attributes: [{ key: 'http.route', value: { stringValue: '/x' } }],
                status: { code: 1 },
                events: [{ timeUnixNano: 1500, name: 'ev' }],
              },
            ],
          },
        ],
      },
      { resource: { attributes: [] }, scopeSpans: [] },
    ],
  };
  const stamped = stampProtobuf(encodeProtobuf(obj), 'tn_real');
  const dec = decodeProtobuf(stamped);
  assert.strictEqual(dec.resourceSpans.length, 2);
  for (const rs of dec.resourceSpans) {
    const t = tenantOf(rs);
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].value.stringValue, 'tn_real');
  }
  const span = dec.resourceSpans[0].scopeSpans[0].spans[0];
  assert.strictEqual(span.name, 'GET /x');
  assert.strictEqual(span.kind, 2);
  assert.strictEqual(Number(span.startTimeUnixNano), 1000);
  assert.strictEqual(span.attributes[0].key, 'http.route');
  assert.strictEqual(span.events[0].name, 'ev');
  assert.strictEqual(dec.resourceSpans[0].resource.attributes[0].value.stringValue, 'svc-a');
});

test('key auth: hash lookup, unknown key, revocation with grace', () => {
  const dbPath = path.join(os.tmpdir(), `tb-test-${Date.now()}-${Math.random()}.db`);
  const db = open(dbPath);
  const key = newIngestKey('t');
  db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run('tn1', 'T1', Date.now());
  db.prepare('INSERT INTO ingest_keys (id, tenant_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('ik1', 'tn1', sha256(key), key.slice(0, 12), Date.now());

  const auth = new KeyAuth(db);
  assert.strictEqual(auth.resolveTenant(key), 'tn1');
  assert.strictEqual(auth.resolveTenant('tb_live_wrong'), null);
  assert.strictEqual(auth.resolveTenant(''), null);
  assert.strictEqual(auth.resolveTenant(null), null);

  // revoked with 60s grace -> still valid now, invalid after cutoff
  db.prepare('UPDATE ingest_keys SET revoked_at = ? WHERE id = ?').run(Date.now() + 60000, 'ik1');
  auth.cache.clear();
  assert.strictEqual(auth.resolveTenant(key), 'tn1', 'valid during grace');
  db.prepare('UPDATE ingest_keys SET revoked_at = ? WHERE id = ?').run(Date.now() - 1, 'ik1');
  auth.cache.clear();
  assert.strictEqual(auth.resolveTenant(key), null, 'invalid after grace');
  fs.rmSync(dbPath, { force: true });
});

test('raw keys never stored: only sha256 hashes in DB', () => {
  const dbPath = path.join(os.tmpdir(), `tb-test-${Date.now()}-${Math.random()}.db`);
  const db = open(dbPath);
  const key = newIngestKey('t');
  db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run('tn1', 'T1', Date.now());
  db.prepare('INSERT INTO ingest_keys (id, tenant_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('ik1', 'tn1', sha256(key), key.slice(0, 12), Date.now());
  const row = db.prepare('SELECT * FROM ingest_keys').get();
  assert.notStrictEqual(row.key_hash, key);
  assert.strictEqual(row.key_hash.length, 64);
  fs.rmSync(dbPath, { force: true });
});
