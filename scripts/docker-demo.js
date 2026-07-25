// Container entrypoint for the demo tenant. The seed runs in the app container,
// so wait for the ingest key to land on the shared volume, then start Astro Store
// with it — the same way a tenant reads its key out of its own environment.
'use strict';

const fs = require('fs');
const cfg = require('../lib/config');

const SECRETS = cfg.env('SEED_SECRETS_PATH', '/data/seed-secrets.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForKey({ timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const key = JSON.parse(fs.readFileSync(SECRETS, 'utf8')).ingest_key;
      if (key) return key;
    } catch {
      /* not seeded yet */
    }
    await sleep(2000);
  }
  throw new Error(`no ingest key at ${SECRETS} — did the app container seed successfully?`);
}

waitForKey()
  .then((key) => {
    process.env.TRACEBILL_KEY = key;
    console.log(`[entrypoint] starting Astro Store with ingest key ${key.slice(0, 12)}…`);
    require('../demo/server.js');
  })
  .catch((e) => {
    console.error(`[entrypoint] ${e.message}`);
    process.exit(1);
  });
