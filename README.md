# InvenFlow Marketplace Tracker

A self-hosted sidecar web application that automates the daily extraction of order data from Indonesian e-commerce platforms (Tokopedia and Shopee) and pushes the results into [InvenFlow](https://github.com/) via service-token API calls. Visual proof (screenshots) is uploaded to InvenFlow's existing storage and operators are notified via WhatsApp (Fonnte) when manual intervention is required.

This repository is a **separate, standalone monorepo** — not a workspace member of `invenflow/`. The two systems communicate only over HTTPS using a bearer service token.

See `PRD_MARKETPLACE_TRACKER_v2.md` (kept in the parent directory for now) for the full product spec.

### Scraping path: Chrome extension (current) vs. server-side worker

Tokopedia and Shopee anti-bot reliably blocks server-side browser automation
(even from a residential Indonesian proxy). The supported way to scrape is the
**Chrome extension in `apps/extension/`**: it runs in a real Chrome on an
always-on machine, with a login session a human established, and POSTs orders to
this app's authenticated `POST /api/ingest` (it reads per-account config from
`GET /api/extension/accounts`; both use the `x-extension-key` header — generate
the key in **Settings → Extension**). The app then forwards each order to
InvenFlow exactly as the worker did.

When scraping via the extension, **disable the server-side Playwright cron by
setting every account's `cronEnabled = false`** in the Accounts UI — the worker's
periodic resync then drops the `scheduled-paid-*` / `scheduled-shipped-*`
repeatables (the `daily-digest` job stays). The `worker` / `novnc` containers
keep running for the daily digest and the interactive (noVNC) login flow. The
Stagehand/Playwright worker (`apps/worker/`) and its on-demand manual-run
endpoints remain in the codebase as a fallback.

---

## Stack

| Layer | Tech |
|---|---|
| Web (UI + API) | Next.js 14, NextAuth, Prisma, Tailwind |
| Browser worker | Stagehand, Playwright + stealth, BullMQ, Xvfb + x11vnc + fluxbox |
| Remote display | noVNC (web) + websockify |
| Reverse proxy | Caddy 2 (auto Let's Encrypt) |
| Datastore | PostgreSQL 16 |
| Queue | Redis 7 |

---

## Prerequisites

- Linux host (Ubuntu 22.04 LTS recommended), 4 GB RAM / 2 vCPU / 40 GB disk minimum.
- Docker 24+ and Docker Compose v2.
- A DNS record pointing at the host (e.g. `tracker.example.com`) for HTTPS via Caddy. For local development you can keep `DOMAIN=localhost`.
- A reachable InvenFlow instance and a service token issued from its `/settings/service-tokens` page.

For local-only development without Docker you also need:

- Node.js 20.10+
- pnpm 9.x (`corepack enable && corepack prepare pnpm@9 --activate`)

---

## First-time setup (per PRD §15.1)

```bash
# 1. Provision a Linux VPS (Ubuntu 22.04 LTS, 4 GB RAM, 2 vCPU, 40 GB disk).

# 2. Install Docker + Compose on the host (one-time):
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out + back in afterwards

# 3. Clone this repo and prepare environment:
git clone <repo-url> invenflow-marketplace-tracker
cd invenflow-marketplace-tracker
cp .env.example .env
# Edit .env — set DOMAIN, DB_PASSWORD, NEXTAUTH_SECRET, ENCRYPTION_KEY,
# INVENFLOW_BASE_URL, INVENFLOW_INITIAL_SERVICE_TOKEN,
# INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD, FONNTE_TOKEN, ADMIN_WA_NUMBER.
# Generate NEXTAUTH_SECRET and ENCRYPTION_KEY with:
#   openssl rand -base64 32

# 4. Boot the stack. The web container will run Prisma migrations and seed the
#    initial admin user on first start.
docker compose -f compose.dev.yaml up -d

# 5. Visit https://${DOMAIN}, log in with INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD,
#    and immediately change the admin password.

# 6. Configure AI Model, InvenFlow connection, and Fonnte from Settings.

# 7. Add a Tokopedia / Shopee Account, click "Open Browser" to perform the
#    initial login through the embedded noVNC session.
```

### Notes on the initial boot

- All host-facing traffic enters through the `caddy` container on ports 80 and 443. None of the other services are exposed to the host.
- Browser profiles persist under `./data/profiles/` on the host (gitignored). They retain cookies and saved logins between scheduler runs, so back them up regularly along with the database (`pg_dump`).
- The `worker` container runs Xvfb on display `:99` and exposes its X server to other containers via x11vnc on `:5900`. The `novnc` sidecar proxies that to a browser-friendly WebSocket on `:6080`, which Caddy serves at `https://${DOMAIN}/novnc/`.

---

## Running locally with Docker Compose

The local-dev compose lives at `compose.dev.yaml` (separate from the production
`docker-compose.yaml` which is wired for Coolify). Always pass `-f` so you don't
accidentally run the production stack:

```bash
cp .env.example .env       # set DOMAIN=localhost for plain HTTP on :80
docker compose -f compose.dev.yaml up --build
# Web UI:  http://localhost/
# Health:  http://localhost/api/health
# noVNC:   http://localhost/novnc/vnc.html
```

Stop / clean up:

```bash
docker compose -f compose.dev.yaml down              # stop, keep volumes
docker compose -f compose.dev.yaml down -v           # stop and DROP postgres + redis volumes
```

---

## Running dev mode without Docker

You still need a Postgres + Redis running somewhere (locally or via `docker compose up postgres redis`). Then:

```bash
pnpm install
pnpm --filter @invenflow-tracker/web exec prisma migrate dev      # once schema lands in B2
pnpm dev                          # runs apps/web and apps/worker in parallel
```

The Next.js app boots on http://localhost:3000 and the worker connects directly to the Redis URL in `.env`.

---

## Production deployment (Coolify)

The production target is `https://tracker.ptunicorn.id`, deployed via Coolify on the "Main Production VPS" using the **Docker Compose** build pack with [`docker-compose.yaml`](./docker-compose.yaml) (Coolify's default discovery path).

That compose file diverges from the local-dev `compose.dev.yaml` in three ways:

1. **No `caddy`** — Coolify's Traefik handles SSL + reverse proxy.
2. **No `postgres` / `redis`** — Coolify manages these as standalone databases (`tracker-postgres-production` and `tracker-redis-production`).
3. **Per-service Traefik labels** route `/`, `/api/*` to `web`, and `/novnc/*` (with prefix stripping) and `/websockify` (no strip) to `novnc`.

### Environment variables

Configure these in the Coolify application's env-var panel:

| Key | Notes |
|---|---|
| `DATABASE_URL` | Internal connection string from the managed Postgres |
| `REDIS_URL` | Internal connection string from the managed Redis |
| `NEXTAUTH_URL` | `https://tracker.ptunicorn.id` |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `APP_URL` | `https://tracker.ptunicorn.id` |
| `INITIAL_ADMIN_EMAIL` | Operator email — used to seed the first admin |
| `INITIAL_ADMIN_PASSWORD` | Strong temporary password — change on first login |
| `INVENFLOW_BASE_URL` | `https://inventory.ptunicorn.id` |
| `INVENFLOW_INITIAL_SERVICE_TOKEN` | `inv_svc_…` token from InvenFlow's `/service-tokens` page (optional — can also be pasted via the sidecar's Settings UI after first deploy) |
| `INITIAL_AI_PROVIDER` / `INITIAL_AI_MODEL` / `INITIAL_AI_API_KEY` | Optional — seeds the AI settings row |
| `FONNTE_TOKEN` / `ADMIN_WA_NUMBER` | Optional — seeds notification config |

### Migrations

The web container's entrypoint (`apps/web/start-prod.sh`) runs `prisma migrate deploy` against `DATABASE_URL` before starting the Next.js server. This makes deploys self-applying — pushing a commit with new migrations to `main` triggers Coolify to rebuild and the new container applies the schema change on startup. A failed migration crashes the container so Coolify retries / surfaces the error rather than serving a stale schema.

The Prisma CLI is installed globally in the Dockerfile's runner stage (pinned to `5.22.0`), and `apps/web/prisma/` (schema + migrations) is copied alongside the standalone bundle so the entrypoint can find them.

### DNS

Add an A record on the `ptunicorn.id` zone:

```
A    tracker    37.60.255.195    auto TTL
```

Cert issuance via Let's Encrypt's http-01 challenge fails until DNS propagates.

### First-time deployment checklist

1. DNS A record live (`dig +short tracker.ptunicorn.id` returns the VPS IP).
2. In InvenFlow's `https://inventory.ptunicorn.id/service-tokens`: create a service token named `marketplace-tracker-production` with permissions `marketplace.ingest`, `marketplace.transition`, `upload`. Copy the `inv_svc_…` value (one-time visibility).
3. Create managed Postgres + Redis in Coolify under the InvenFlow project.
4. Create the Docker Compose application in Coolify pointing at this repo's `main` branch and `docker-compose.coolify.yml`.
5. Set the env vars listed above. Paste the service token into `INVENFLOW_INITIAL_SERVICE_TOKEN`.
6. Trigger the first deploy. The web container's entrypoint will apply migrations and seed the initial admin from `INITIAL_ADMIN_*` env vars.
7. Verify `https://tracker.ptunicorn.id/api/health` returns `{ "status": "ok", … }`.
8. Log in as the seeded admin, walk through Settings → Test Connection on each tab.

### Backups

In Coolify, enable scheduled backups on `tracker-postgres-production` (daily, 02:00 Asia/Jakarta). The browser-profile volume (`tracker_profiles`) is **not** backed up by default; if it is lost, re-login to each marketplace via the Open Browser flow.

---

## Repository layout

See PRD §6 for the canonical layout. Top-level:

```
invenflow-marketplace-tracker/
├── apps/
│   ├── web/        # Next.js 14 — UI + API routes
│   └── worker/     # BullMQ workers + Stagehand browser automation
├── packages/
│   └── shared/     # Shared Zod schemas / types
├── docker/
│   ├── novnc/      # Dockerfile for the noVNC web client
│   └── caddy/      # Caddyfile — reverse proxy + auto HTTPS
├── data/           # Bind-mount targets (postgres, redis, profiles) — gitignored
├── docker-compose.yaml      # production stack (Coolify deployment target)
├── compose.dev.yaml         # local full-stack dev (caddy + postgres + redis bundled)
├── .env.example
└── README.md
```

---

## Development status

v1 feature-complete: Tokopedia + Shopee scrapers, ingest pipeline with InvenFlow contract, lifecycle transitions with §3.4 concurrency rule, interactive browser session via noVNC, run history, dashboard, cron scheduler, Fonnte notifications, daily digest. Open items tracked in [`/Users/yanuar/.claude/plans/splendid-tickling-crescent.md`](../../../.claude/plans/splendid-tickling-crescent.md) — primarily real-account validation (URL drift, DOM extraction tuning, login-redirect signals) which only surfaces against live Tokopedia/Shopee accounts.
