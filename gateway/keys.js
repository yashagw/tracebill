// Ingest key auth. Keys are stored as sha256 hashes and the tenant id is
// derived only from the key — never from anything else in the request.
'use strict';

const { sha256 } = require('../lib/ids');

const CACHE_TTL_MS = 5000;

class KeyAuth {
  constructor(db) {
    this.db = db;
    this.cache = new Map(); // key_hash -> {tenantId|null, at}
  }

  /** tenant_id, or null if unknown or past revoked_at. */
  resolveTenant(rawKey) {
    if (!rawKey || typeof rawKey !== 'string' || rawKey.length > 200) return null;
    const hash = sha256(rawKey);
    const hit = this.cache.get(hash);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tenantId;
    const row = this.db
      .prepare('SELECT tenant_id, revoked_at FROM ingest_keys WHERE key_hash = ?')
      .get(hash);
    let tenantId = null;
    if (row && (row.revoked_at === null || row.revoked_at > Date.now())) {
      tenantId = row.tenant_id;
    }
    this.cache.set(hash, { tenantId, at: Date.now() });
    return tenantId;
  }
}

module.exports = { KeyAuth };
