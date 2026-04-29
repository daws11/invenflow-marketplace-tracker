# InvenFlow Marketplace Tracker

A self-hosted sidecar web application that automates the daily extraction of order data from Indonesian e-commerce platforms (Tokopedia and Shopee) and pushes the results into [InvenFlow](https://github.com/) via service-token API calls. Visual proof (screenshots) is uploaded to InvenFlow's existing storage and operators are notified via WhatsApp (Fonnte) when manual intervention is required.

This repository is a **separate, standalone monorepo** — not a workspace member of `invenflow/`. The two systems communicate only over HTTPS using a bearer service token.

See `PRD_MARKETPLACE_TRACKER_v2.md` (kept in the parent directory for now) for the full product spec.

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
docker compose up -d

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

```bash
cp .env.example .env       # set DOMAIN=localhost for plain HTTP on :80
docker compose up --build
# Web UI:  http://localhost/
# Health:  http://localhost/api/health
# noVNC:   http://localhost/novnc/vnc.html
```

Stop / clean up:

```bash
docker compose down              # stop, keep volumes
docker compose down -v           # stop and DROP postgres + redis volumes
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
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Development status

This repository is currently at **B1: skeleton + Docker stack only**. The web app serves a placeholder page and a stubbed `/api/health` endpoint; the worker just logs `worker starting` and idles. Real schemas, NextAuth handlers, scrapers, and integration logic land in subsequent workstreams (B2, B3, C1+).
