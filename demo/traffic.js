/**
 * Drives real HTTP at Astro Store as three end-customers, at different volumes.
 * Nothing here injects telemetry — the engine only ever sees spans produced by
 * these requests.
 *
 *   node demo/traffic.js            # continuous mixed traffic until Ctrl-C
 *   node demo/traffic.js --burst    # one deterministic burst, then exit
 */
'use strict';

const BASE = process.env.ASTRO_URL || `http://localhost:${process.env.DEMO_PORT || 3002}`;

const CUSTOMERS = [
  { key: 'ak_acme_1', name: 'acme', weight: 6 },
  { key: 'ak_globex_1', name: 'globex', weight: 3 },
  { key: 'ak_initech_1', name: 'initech', weight: 1 },
];
const ROUTES = [
  { method: 'GET', path: '/api/products', weight: 7 },
  { method: 'POST', path: '/api/checkout', weight: 2 },
  { method: 'GET', path: '/api/slow', weight: 1 },
];

const pick = (arr) => {
  const total = arr.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const a of arr) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return arr[arr.length - 1];
};

async function hit(customer, route) {
  try {
    const res = await fetch(`${BASE}${route.path}`, {
      method: route.method,
      headers: { 'x-api-key': customer.key, 'content-type': 'application/json' },
      body: route.method === 'POST' ? JSON.stringify({ productId: 1 }) : undefined,
    });
    process.stdout.write(`${customer.name.padEnd(8)} ${route.method} ${route.path} -> ${res.status}\n`);
  } catch (e) {
    process.stdout.write(`${customer.name.padEnd(8)} ${route.method} ${route.path} -> ERR ${e.message}\n`);
  }
}

async function burst() {
  // Fixed volumes, so the invoice totals are easy to check by eye.
  const plan = [
    ['ak_acme_1', 'acme', 30],
    ['ak_globex_1', 'globex', 15],
    ['ak_initech_1', 'initech', 5],
  ];
  for (const [key, name, n] of plan) {
    for (let i = 0; i < n; i++) {
      const route = i % 5 === 4 ? ROUTES[1] : ROUTES[0];
      await hit({ key, name }, route);
    }
  }
  console.log('burst done: acme=30 globex=15 initech=5');
  process.exit(0);
}

async function continuous() {
  console.log(`traffic -> ${BASE} (Ctrl-C to stop)`);
  for (;;) {
    await hit(pick(CUSTOMERS), pick(ROUTES));
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 900));
  }
}

if (process.argv.includes('--burst')) burst();
else continuous();
