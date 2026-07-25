# TraceBill

**Invoices with receipts.** Usage-based billing for API companies — powered by the
telemetry they already emit.

Competitors (Metronome, Orb, Lago) make you build a second "billing events"
pipeline next to your observability pipeline — and then your customers must trust
the invoice number. TraceBill's thesis: **if you're instrumented with
OpenTelemetry, you already emit your billing data.** One `init()` call and you're
metering; every invoice line item expands into per-request receipts with a
built-in trace waterfall. Disputes die on evidence.

```js
const tracebill = require('@tracebill/node');
tracebill.init({
  key: process.env.TRACEBILL_KEY,
  identify: (req) => apiKeyToCustomer(req),   // who to bill for this request
});
```

That's the entire integration (see it live in [`demo/server.js`](demo/server.js)).

## The SigNoz-inside disclosure (for judges)

**SigNoz is TraceBill's internal engine — tenants never see it.** It plays the
role ClickHouse or Postgres plays in other products: the full-fidelity telemetry
store and query layer that makes trace-granular billing receipts possible.
Concretely, TraceBill exercises:

- the **OTLP/HTTP ingest path** (`:4318`) — the gateway authenticates tenant keys
  and stamps `tracebill.tenant_id` into every resource before forwarding;
- **resource-attribute multi-tenancy** — every engine query filters on the stamped
  tenant attribute; trace fetches re-verify span attributes before serving;
- **query API v5** builder queries over the traces signal — scalar aggregations
  (`count()`, `sum(duration_nano)`, `sum(billing.response_bytes)` grouped by
  customer/SKU), raw paged span lists for receipts, and timeseries for dashboards;
- **span-level trace fetches** (`/api/v1/traces/:id`) feeding a white-labeled
  waterfall viewer inside a billing product.

We didn't invent a proprietary event format — TraceBill speaks OpenTelemetry on
the wire. Tenants never think about that either: from their side it's a generic
usage-tracking + billing SaaS, and **no SigNoz terminology, UI, or links appear
anywhere in the tenant-visible portal.**

## Architecture

```
 TENANT SIDE (no SigNoz/OTel visible)          TRACEBILL PLATFORM (SigNoz inside)
┌─────────────────────────────┐    OTLP/HTTP   ┌──────────────────────────────────┐
│ Astro Store (demo tenant)   │  + key header  │ gateway :4400                    │
│  @tracebill/node SDK        │───────────────▶│  key -> tenant, stamp            │
│  tracebill.init({key,       │                │  tracebill.tenant_id, forward ───┼──▶ SigNoz (internal)
│    identify: req => cust})  │                └──────────────────────────────────┘    :8080 query API
└─────────────────────────────┘                ┌──────────────────────────────────┐    :4318 OTLP
                                               │ app :4500  (API+portal+engine)   │◀── aggregates + spans
        tenant dashboard  ◀────────── HTTP ────│  pricing -> invoices -> receipts │
        end-customer invoice link  ◀───────────│  + white-label trace waterfall   │
                                               └────────────── SQLite ────────────┘
```

Three processes, one repo, one SQLite file:

| Process | Port | Role |
|---|---|---|
| `gateway` | 4400 | Ingest: authenticates `X-TraceBill-Key`, stamps tenant into every OTLP resource (JSON **and** protobuf), forwards |
| `app` | 4500 | Portal API + static portal + billing engine loops (meter every 15s, close after period end) |
| `demo` | 3002 | Astro Store — a real Express API integrated via the real SDK |

`npm run dev` starts all three in one terminal with prefixed logs.

Billing model: fixed 5-minute UTC periods (monthly in production framing);
integer micro-dollar unit prices and integer cent totals (BigInt math, one
round-half-up per line); invoices idempotent per (tenant, customer, period);
receipts dedupe on (line, span_id); closed periods immutable; per-invoice
reconciliation badge (metered aggregate vs span-level receipts).

Quotas close the loop back into the API: when a customer passes their
`calls_per_period`, the engine flags them, the SDK's `guard()` middleware picks
that up from the gateway within 5s and returns 429, and the refused requests show
on the dashboard as blocked — recorded, never billed.

## Quickstart

Prereqs: Node ≥ 22.5 (uses built-in `node:sqlite`), a local SigNoz with OTLP at
`:4318` and query API at `:8080`.

```bash
cp .env.example .env  # then fill in SIGNOZ_PAT (or email/password + org id)
npm install
npm run seed          # prints portal login + ingest key (once); wires demo/.env

npm run dev           # gateway :4400, app :4500 (portal), demo API :3002
# or run them separately: npm run gateway | npm run app | npm run demo

npm run traffic       # real HTTP from acme/globex/initech, until Ctrl-C
# or: node demo/traffic.js --burst   (deterministic: acme=30 globex=15 initech=5)
```

Open http://localhost:4500, sign in with the seeded `founder@astrostore.dev`
credentials (printed by seed; also in `.seed-secrets.json`), and watch usage and
revenue tick. Open an invoice → click a call line → click a usage record → the
trace waterfall renders inside TraceBill. "Copy customer link" produces the
read-only `/share/<token>` invoice for the end-customer.

### Tests

```bash
npm test              # 23 unit tests, no external dependencies
npm run test:e2e      # end-to-end against a live local SigNoz (~3-4 min)
```

The unit tests cover money and pricing, SKU derivation, OTLP stamping in both
JSON and protobuf, key auth and revocation, invoice idempotency, closed-period
immutability, reconciliation, and trace scoping.

The E2E test spawns the real gateway, app and demo tenant, sends exactly
acme=17 (12 products + 5 checkout), globex=7, initech=3 and 2 unattributed
requests through the real SDK, then asserts the invoice quantities and receipt
counts equal those numbers, that every receipt's trace resolves through the
scoped waterfall API, that a second tenant sees none of it, that a share token
reads only its own customer, and that closed invoices stay byte-identical as new
traffic arrives.

## Security model (implemented + tested)

| Credential | Grants |
|---|---|
| Ingest key `tb_live_…` (sha256 stored, shown once) | write-only telemetry for that tenant |
| Dashboard session (HttpOnly cookie, 24h sliding) | that tenant's data via portal API |
| Share token `shr_…` (hash stored, deterministic per invoice) | read-only: one customer's invoice + receipts + waterfalls |
| Telemetry-store credential (env) | app process only; never leaves the server |

Two invariants hold everywhere:
1. `tenant_id` is **always resolved server-side** from the credential — never from
   a request body/param. Every telemetry query injects it as a filter; every
   SQLite query includes it.
2. Trace fetches **re-verify span attributes** before serving: every span must
   carry the caller's `tracebill.tenant_id` (and the share token's customer id)
   or the API returns 404. Cross-tenant probes get 404, not 403.

The gateway **overwrites** any client-supplied `tracebill.tenant_id`, so a tenant
cannot spoof another tenant even at the OTLP layer.

## Status

**Covered by the test suite**, all passing locally against a live SigNoz: the 23
unit tests and the end-to-end run described above. A manual burst of
acme=30/globex=15/initech=5 produced the same 30/15/5 split in both the SigNoz
aggregate and the invoices, and every invoice closed reconciled.

**Known limitations:**
- Quota enforcement is driven by the engine's own metering rather than by a SigNoz
  alert rule. `POST /api/v1/webhooks/quota-alert` accepts an Alertmanager-shaped
  payload for that path, but the alert rule itself is not provisioned.
- Prefer `SIGNOZ_PAT`. Without one the engine signs in with email/password and
  refreshes a session JWT every 20 minutes; that works, but a PAT is the right
  credential for a service.
- Pricing is edited in `pricing.yaml` — there is no pricing UI. No self-serve
  signup, payments, tax or currency handling, or historical backfill.
- The SDK ships an Express convention for other frameworks and a BYO-OpenTelemetry
  coexistence path; both are documented rather than demonstrated.
- `applyCustomAttributesOnSpan` reads `span.attributes['http.route']`, an SDK
  rather than API property. If the route isn't set yet, the SKU falls back to the
  normalized URL path — the same value for every demo route, and unit-tested for
  parameterized paths.

## Demo script (3 minutes)

1. **Onboarding** (`/onboarding`): install the SDK, paste your key, say who to
   bill. Show the `tracebill.init()` block in `demo/server.js` — that's the diff.
2. **Live metering**: `npm run traffic`. acme/globex/initech hit Astro Store at
   different volumes; the activity tape and revenue tick as it happens.
3. **The receipt**: open Acme's invoice → a line item → usage records → click one,
   and the trace waterfall renders inside TraceBill, with the compute charge split
   across spans by self-time. Every charge has this receipt.
4. **Share it**: Copy customer link, open in a private window. Read-only invoice
   and receipts, nothing else, plus the reconciliation badge — ✓ complete means the
   metered count was cross-checked against span-level evidence.
5. **Enforcement**: acme's quota is 20 calls, so it trips early. Its card flips to
   rate-limited and further requests appear on the tape as blocked at $0.00.
6. **Architecture**: under the hood this is OpenTelemetry and SigNoz. Tenants never
   see either; they get billing that can prove itself.

Screenshots: [`docs/screenshots/`](docs/screenshots/) (login, dashboard,
onboarding, invoice, receipts, waterfall, share view).

## Out of scope

Payments, tax and currency handling, tenant self-serve signup (tenants are
seeded), a pricing editor UI, SigNoz Cloud, historical backfill.

## Repo layout

```
sdk/        @tracebill/node — init(), guard(), identify/sku hooks, OTel inside
gateway/    ingest: key auth, tenant stamping (JSON + protobuf), forward
engine/     telemetry client (auth, aggregation, receipts, waterfall, scoping) + billing loops
app/        REST API + auth + serves the portal; runs the engine in-process
portal/     dashboard, invoice + receipts + waterfall, share view (plain HTML/JS)
demo/       Astro Store demo tenant + traffic generator
lib/        config, sqlite schema, ids/hashing, integer money, pricing, rate limit
scripts/    seed, dev runner
test/       unit + end-to-end
```

MIT licensed. See [LICENSE](LICENSE).
