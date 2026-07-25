# How TraceBill works

Everything in here is implementation detail. For what the product does, see the
[README](../README.md).

## SigNoz is the engine, not the product

**SigNoz is TraceBill's internal telemetry store — tenants never see it.** It plays
the role ClickHouse or Postgres plays in other products: the full-fidelity store
and query layer that makes trace-granular billing receipts possible.

TraceBill exercises:

- the **OTLP/HTTP ingest path** (`:4318`) — the gateway authenticates tenant keys
  and stamps `tracebill.tenant_id` into every resource before forwarding;
- **resource-attribute multi-tenancy** — every query filters on the stamped tenant
  attribute, and trace fetches re-verify span attributes before serving;
- **query API v5 builder queries** over the traces signal — scalar aggregations
  (`count()`, `sum(duration_nano)`, `sum(billing.response_bytes)` grouped by
  customer and SKU), raw paged span lists for receipts, and timeseries for charts;
- **span-level trace fetches** (`/api/v1/traces/:id`) feeding a white-labeled
  waterfall viewer inside a billing product.

There is no proprietary event format — TraceBill speaks OpenTelemetry on the wire.
Tenants never think about that either: from their side it is a usage-tracking and
billing SaaS, and no SigNoz terminology, UI or links appear anywhere in the
tenant-visible portal.

## Processes

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

| Process | Port | Role |
|---|---|---|
| `gateway` | 4400 | Ingest: authenticates `X-TraceBill-Key`, stamps tenant into every OTLP resource (JSON **and** protobuf), forwards |
| `app` | 4500 | Portal API + static portal + billing engine loops (meter every 15s, close after period end) |
| `demo` | 3002 | Astro Store — a real Express API integrated via the real SDK |

The gateway and the app share one SQLite file, so they run in the same container.
The demo tenant only speaks HTTP to the gateway and runs on its own.

## Billing model

Fixed 5-minute UTC periods (monthly in production framing). Integer micro-dollar
unit prices and integer cent totals, BigInt throughout, with exactly one
round-half-up per line — no float ever touches money.

Four properties the rest of the system leans on:

- invoices are idempotent per (tenant, customer, period_start);
- line ids are derived from (invoice, sku), so receipts survive a recompute;
- receipts dedupe on (invoice_line_id, span_id), which together with metering
  server spans only makes at-least-once ingest safe to replay;
- closed invoices never change — every write goes through `assertInvoiceOpen()`.

Each invoice carries a reconciliation badge comparing the metered aggregate
against the span-level receipts actually on file.

## Quota enforcement

When a customer passes their `calls_per_period`, the engine flags them. The SDK's
`guard()` middleware polls the gateway every 5s, picks up the flag and returns 429
with `Retry-After`. Refused requests are stamped with a separate
`billing.blocked_customer_id` attribute rather than `billing.customer_id`, so
metering skips them while the dashboard still shows them as blocked at $0.00.

`POST /api/v1/webhooks/quota-alert` accepts an Alertmanager-shaped payload for the
same purpose, but the SigNoz alert rule that would drive it is not provisioned —
enforcement runs off the engine's own metering.

## Security model

| Credential | Grants |
|---|---|
| Ingest key `tb_live_…` (sha256 stored, shown once) | write-only telemetry for that tenant |
| Dashboard session (HttpOnly cookie, 24h sliding) | that tenant's data via the portal API |
| Share token `shr_…` (hash stored, deterministic per invoice) | read-only: one customer's invoice, receipts and waterfalls |
| Telemetry-store credential (env) | app process only; never leaves the server |

Two invariants hold everywhere:

1. `tenant_id` is **always resolved server-side** from the credential, never from a
   request body or param. Every telemetry query injects it as a filter and every
   SQLite query includes it.
2. Trace fetches **re-verify span attributes** before serving. Every span must
   carry the caller's `tracebill.tenant_id`, and the share token's customer id
   where applicable, or the API returns 404. Cross-tenant probes get 404, not 403.

The gateway **overwrites** any client-supplied `tracebill.tenant_id`, so a tenant
cannot spoof another tenant even at the OTLP layer.

## Tests

```bash
npm test              # 23 unit tests, no external dependencies
npm run test:e2e      # end-to-end against a live SigNoz (~3-4 min)
```

The unit tests cover money and pricing, SKU derivation, OTLP stamping in both JSON
and protobuf, key auth and revocation, invoice idempotency, closed-period
immutability, reconciliation, and trace scoping.

The E2E test spawns the real gateway, app and demo tenant, sends exactly acme=17
(12 products + 5 checkout), globex=7, initech=3 and 2 unattributed requests
through the real SDK, then asserts the invoice quantities and receipt counts equal
those numbers, that every receipt's trace resolves through the scoped waterfall
API, that a second tenant sees none of it, that a share token reads only its own
customer, and that closed invoices stay byte-identical as new traffic arrives.

## How the engine authenticates

`engine/signoz.js` prefers a personal access token in `SIGNOZ_PAT`, sent as
`SIGNOZ-API-KEY`. On SigNoz v0.134.0 there is no working API to mint one:

- `POST /api/v1/pats` is not routed and falls through to the SPA;
- `GET /api/v1/user/apikeys` is routed, but into the `/api/v1/user/{id}` handler,
  which panics on `MustNewUUID("apikeys")` and returns 500.

So the engine falls back to `POST /api/v2/sessions/email_password`, refreshing the
session JWT every 20 minutes because those expire in about 30, and retrying once
on a 401. `orgID` is required on that call and there is no endpoint that maps an
email to an org, so it has to be captured when the account is created.

`scripts/bootstrap-signoz.js` does exactly that on a fresh backend: it claims the
first-user slot via `POST /api/v1/register`, which returns the `orgId`, verifies
the login works, and writes the three values to a file next to the database. The
account is local and disposable (`ops@tracebill.local`), so no personal credential
is involved, and `SIGNOZ_PAT` still takes precedence if one ever becomes available.

## Status and limitations

Covered by the suite above, passing against a live SigNoz. A burst of
acme=30/globex=15/initech=5 through the Docker stack produced 50 charges and 50
span-level receipts, 100% reconciled, with acme 429'd on its 21st call.

Known limitations:

- Quota enforcement is driven by the engine's own metering rather than a SigNoz
  alert rule (see above).
- The engine authenticates with a session JWT rather than a token, because this
  SigNoz build cannot mint one (see above).
- Pricing is edited in `pricing.yaml`; there is no pricing UI.
- No payments, tax or currency handling, tenant self-serve signup, or historical
  backfill.
- The SDK ships an Express convention for other frameworks and a
  BYO-OpenTelemetry coexistence path; both are documented rather than demonstrated.
- `applyCustomAttributesOnSpan` reads `span.attributes['http.route']`, an SDK
  rather than API property. If the route isn't set yet the SKU falls back to the
  normalized URL path — the same value for every demo route, and unit-tested for
  parameterized paths.

## Repo layout

```
sdk/        @tracebill/node — init(), guard(), identify/sku hooks, OTel inside
gateway/    ingest: key auth, tenant stamping (JSON + protobuf), forward
engine/     telemetry client (auth, aggregation, receipts, waterfall, scoping) + billing loops
app/        REST API + auth + serves the portal; runs the engine in-process
portal/     dashboard, invoice + receipts + waterfall, share view (plain HTML/JS)
demo/       Astro Store demo tenant + traffic generator
lib/        config, sqlite schema, ids/hashing, integer money, pricing, rate limit
scripts/    seed, dev runner, SigNoz bootstrap
docker/     Dockerfile, ClickHouse cluster config, vendored collector config
test/       unit + end-to-end
```
