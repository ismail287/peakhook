# PeakHook

[![Docker verify](https://github.com/ismail287/peakhook/actions/workflows/docker-verify.yml/badge.svg)](https://github.com/ismail287/peakhook/actions/workflows/docker-verify.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1DCBAF.svg)](LICENSE)
[![Docker Ready](https://img.shields.io/badge/docker-ready-2496ED.svg?logo=docker&logoColor=white)](docker-compose.yml)
[![Self-Hosted](https://img.shields.io/badge/self--hosted-yes-F0A830.svg)](#quick-start)
[![Node 20](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](package.json)

**Self-hosted webhook vault, inspector and replay gateway for n8n, Make and Zapier.**
Capture webhooks from Stripe, Shopify, GitHub, Typeform and anything else. Store them safely, forward them to your automation, inspect every header and payload, and replay a failed delivery with one click.

## One-Click Deploy to Hostinger

<!-- When the official Hostinger Open Source Partner 1-click button is approved, swap this link for it. -->
[![Deploy to Hostinger VPS](https://img.shields.io/badge/Deploy%20to-Hostinger%20VPS-673DE6?style=for-the-badge)](https://www.hostinger.com/in?REFERRALCODE=digitalbyismail)

*Referral link: if you sign up through it, the author may earn a commission at no extra cost to you. PeakHook runs on any Docker host, so you are free to use another provider.*

Deploy in two minutes on a Hostinger VPS that has Docker (Hostinger's Docker Manager, or SSH):

1. Create a VPS with the **Docker** template and open its Docker Manager (or SSH in).
2. Create a project from this repository's `docker-compose.yml` (**Compose from URL**, or `git clone` then `docker compose up -d`).
3. Set the environment variable `ADMIN_PASSWORD` to a long, private value. This is your dashboard password.
4. Open `http://YOUR-SERVER-IP:3000`, sign in, and press **Load Demo Webhooks** to see it working.

> **Change `ADMIN_PASSWORD` before you expose the app to the internet.** The defaults (`changeme`, `admin123`) exist only so the first start works. The dashboard shows a warning banner while a default is in use.

## How it works

```
 Stripe ─┐
 Shopify ┼──▶  PeakHook Vault  ──▶  n8n / Make / Zapier
 GitHub ─┤     (store + inspect)     (your workflows)
 Typeform┘          │  ▲
                    │  └── 1-click Replay for failed deliveries
                    ▼
            SQLite  ./data/peakhook.db  (kept for RETENTION_DAYS)
```

1. Point your service (Stripe, Shopify...) at `https://your-host/hook/<slug>`.
2. PeakHook stores the **exact** request: method, headers, query string, raw body, client IP and time. It answers `200` immediately, so the sender never waits on your workflow.
3. If the endpoint has a forward URL (or `DEFAULT_FORWARD_URL` is set) PeakHook relays the request, including signature headers, and records the HTTP status and latency.
4. If your n8n was down or a workflow errored, open the webhook in the dashboard and press **Replay to n8n**. The original bytes are sent again and the new result is added to the delivery history.

## Features

- **Webhook vault:** every request on `/hook/:slug` is stored in SQLite (any HTTP method, up to `MAX_BODY_BYTES`).
- **Inspector:** syntax-highlighted JSON payload, headers, query parameters and a full delivery history per webhook.
- **Forwarding:** relay to an n8n, Make or Zapier URL per endpoint, with status code, latency, timeout and error capture.
- **1-click replay:** re-send the stored payload (same bytes, same signature headers) to the configured URL or to one you paste.
- **Provider detection:** Stripe, Shopify, GitHub and Typeform events are labelled automatically (`invoice.payment_failed`, `orders/create`, ...).
- **Demo data:** `POST /api/seed-demo` (or the **Load Demo Webhooks** button) creates 5 realistic sample webhooks.
- **Automatic retention:** old webhooks are purged after `RETENTION_DAYS`.
- **Light and private:** one npm dependency (`better-sqlite3`), no external requests, no telemetry, no build step.
- **Safe defaults:** admin password required for the whole API, constant-time comparison, login throttling, loop protection, body size limit, non-root container, security headers.

## Quick start

```bash
cp .env.example .env        # then edit ADMIN_PASSWORD
docker compose up -d
```

Open <http://localhost:3000> and sign in with your `ADMIN_PASSWORD`. Data lives in `./data` and survives restarts and upgrades.

**Without Docker** (Node 20+):

```bash
npm ci
ADMIN_PASSWORD='a-long-private-password' node server.js
```

**With n8n and Postgres in one stack:**

```bash
cp .env.example .env        # set ADMIN_PASSWORD, POSTGRES_PASSWORD and N8N_ENCRYPTION_KEY
docker compose -f docker-compose.n8n-stack.yml up -d
```

PeakHook is on port 3000 and n8n on port 5678. Inside the stack, use `http://n8n:5678/webhook/<your-path>` as an endpoint's forward URL.

### Using it

1. Create an endpoint (name + optional forward URL). Copy its URL, e.g. `https://hooks.example.com/hook/stripe-payments`.
2. Paste that URL into Stripe, Shopify, GitHub or Typeform as the webhook target.
3. Watch requests appear live. Click one to inspect it; press **Replay to n8n** to re-send it.

```bash
# quick test from your terminal
curl -X POST http://localhost:3000/hook/<slug> -H 'content-type: application/json' -d '{"hello":"world"}'
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | *(required)* | Dashboard and API password. The server refuses to start without it. |
| `PORT` | `3000` | Port the app listens on. |
| `RETENTION_DAYS` | `30` | Delete webhooks older than this many days. `0` keeps everything. |
| `DEFAULT_FORWARD_URL` | *(empty)* | Forward webhooks of endpoints without their own forward URL here. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy to use `X-Forwarded-For` / `X-Forwarded-Proto`. |
| `PUBLIC_URL` | *(auto)* | Base URL shown in the dashboard, e.g. `https://hooks.example.com`. |
| `MAX_BODY_BYTES` | `1048576` | Largest accepted webhook body (HTTP 413 above it). |
| `FORWARD_TIMEOUT_MS` | `10000` | Timeout for forwarding and replaying. |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Where `peakhook.db` is stored. |

The n8n stack file also uses `POSTGRES_PASSWORD` and `N8N_ENCRYPTION_KEY` (required) plus a few optional n8n settings. See [.env.example](.env.example).

## API

Every `/api/*` call needs the admin password: `Authorization: Bearer <password>`, HTTP Basic (any username), or `X-Admin-Password: <password>`. `/hook/*` and `/api/health` are public.

| Method | Path | What it does |
|---|---|---|
| `ALL` | `/hook/:slug` | Capture a webhook (public). Responds `200 {"ok":true,"id":...}`. |
| `GET` | `/api/health` | Health check (public), used by the Docker `HEALTHCHECK`. |
| `GET` / `POST` | `/api/endpoints` | List or create endpoints (`name`, optional `slug`, `forward_url`). |
| `PATCH` / `DELETE` | `/api/endpoints/:id` | Rename, change forward URL, or delete an endpoint and its logs. |
| `GET` | `/api/logs` | List webhooks (`?endpoint_id=`, `?limit=`, `?before_id=`). |
| `GET` / `DELETE` | `/api/logs/:id` | Full webhook (headers, body, deliveries) or delete it. `DELETE /api/logs` clears all. |
| `POST` | `/api/replay/:id` | Re-send a stored webhook. Optional body `{"url": "..."}` overrides the target. |
| `POST` | `/api/seed-demo` | Create 5 sample webhooks. |

## Security notes

- Put PeakHook behind HTTPS (a reverse proxy such as Caddy, Nginx or Traefik, or Hostinger's domain/SSL options) and set `TRUST_PROXY=true`.
- The webhook URL slug is the only secret protecting `/hook/*`. Leave the slug empty when creating an endpoint to get a random 16-character one.
- Forward URLs are set by whoever knows the admin password and can point at internal addresses such as `http://n8n:5678`. Do not share the admin password.
- Stored webhooks can contain personal data and signatures. Keep `RETENTION_DAYS` as low as you can. Clean sensitive payloads before sharing them with the free tools below.

## Development

```bash
npm ci
npm test        # starts the server and a mock n8n, and checks every endpoint
```

Project layout: `server.js` (API, capture, forwarding), `public/` (dashboard), `test/smoke.test.js`, `Dockerfile`, `docker-compose.yml`, `docker-compose.n8n-stack.yml`.

## More from Peak Automations

- **Free browser-based tools:** <https://peakautomations.online/tools/> (n8n workflow sanitizer, webhook PII scrubber, cron visualizer and more)
- **Automation templates for n8n and Make.com:** <https://peakautomations.online/templates/>

## License

[MIT](LICENSE) © 2026 Peak Automations. Built by [Peak Automations](https://peakautomations.online).
