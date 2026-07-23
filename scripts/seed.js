/**
 * Creates two tenants, their logins, ingest keys and customer display names.
 * Credentials are printed once and written to demo/.env (the demo app reads its
 * key from there) and .seed-secrets.json (a local copy, gitignored).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config');
const { open } = require('../lib/db');
const { hashPassword } = require('../app/auth');
const { sha256, newIngestKey, newId, randToken } = require('../lib/ids');

const TENANT_ID = 'astro-store';
const TENANT_2_ID = 'globex-labs'; // exists so tenant isolation can be checked by hand
const FOUNDER_EMAIL = 'founder@astrostore.dev';

function seedTenant(db, { id, name, email, password, keyTag, customers = {} }) {
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
  db.prepare(
    `INSERT INTO tenant_users (id, tenant_id, email, password_hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`
  ).run(newId('usr'), id, email, hashPassword(password));
  const key = newIngestKey(keyTag);
  db.prepare('UPDATE ingest_keys SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL').run(now, id);
  db.prepare('INSERT INTO ingest_keys (id, tenant_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`ik_${sha256(key).slice(0, 12)}`, id, sha256(key), key.slice(0, 12), now);
  for (const [ext, display] of Object.entries(customers)) {
    db.prepare(
      `INSERT INTO customers (id, tenant_id, external_id, display_name) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, external_id) DO UPDATE SET display_name = excluded.display_name`
    ).run(newId('cus'), id, ext, display);
  }
  return key;
}

function main() {
  const db = open(cfg.DB_PATH);
  const founderPassword = `astro-${randToken(10)}`;
  const founder2Password = `globex-${randToken(10)}`;

  const key = seedTenant(db, {
    id: TENANT_ID,
    name: 'Astro Store',
    email: FOUNDER_EMAIL,
    password: founderPassword,
    keyTag: 'astro',
    customers: { acme: 'Acme Corp', globex: 'Globex Inc', initech: 'Initech LLC' },
  });
  const key2 = seedTenant(db, {
    id: TENANT_2_ID,
    name: 'Globex Labs',
    email: 'ops@globexlabs.dev',
    password: founder2Password,
    keyTag: 'glx',
    customers: {},
  });

  fs.writeFileSync(
    path.join(cfg.ROOT, 'demo', '.env'),
    `TRACEBILL_KEY=${key}\nTRACEBILL_ENDPOINT=http://localhost:${cfg.GATEWAY_PORT}/v1/traces\n`
  );
  const secrets = {
    portal_url: `http://localhost:${cfg.APP_PORT}`,
    tenant: TENANT_ID,
    login: { email: FOUNDER_EMAIL, password: founderPassword },
    ingest_key: key,
    second_tenant: { id: TENANT_2_ID, login: { email: 'ops@globexlabs.dev', password: founder2Password }, ingest_key: key2 },
  };
  fs.writeFileSync(path.join(cfg.ROOT, '.seed-secrets.json'), JSON.stringify(secrets, null, 2));

  console.log('Seeded TraceBill.');
  console.log('');
  console.log(`  Portal:        http://localhost:${cfg.APP_PORT}`);
  console.log(`  Dashboard:     ${FOUNDER_EMAIL} / ${founderPassword}`);
  console.log(`  Ingest key:    ${key}   (Astro Store — shown once)`);
  console.log(`  2nd tenant:    ops@globexlabs.dev / ${founder2Password} (isolation check)`);
  console.log('');
  console.log('  Copies written to demo/.env and .seed-secrets.json.');
}

main();
