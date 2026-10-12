# Timbre Lossless Cloudflare Worker & Telegram Bot

Authenticated high-resolution 24-bit FLAC audio stream resolver and quota gateway for **[Timbre](https://github.com/sksalapur/Timbre)**.

## Features

- 💎 **Studio FLAC Resolver**: Resolves search queries and direct 24-bit/96–192kHz uncompressed audio streams.
- 🤖 **Telegram Bot Management**: Zero web browser login. Users start @TimbreLosslessBot to obtain private URLs, inspect daily stream consumption, and regenerate tokens.
- ⚡ **Strict Daily Quota**: 250 streams / day per user token, resetting at 00:00 UTC. Exceeding returns 429 Too Many Requests.
- 🌐 **Cloudflare Workers + D1**: Ultra-low latency edge compute with SQLite persistent storage (5M reads/day & 100K writes/day on Cloudflare Free tier).

---

## Architecture

- GET /u/:token/manifest.json: Addon descriptor conforming to BitChord / Timbre Addon Protocol.
- GET /u/:token/search?q=...: High-resolution catalog search.
- GET /u/:token/stream/:id: Verifies private token, enforces daily 250 stream quota, increments count, and returns signed Hi-Res FLAC stream URL.
- POST /webhook: Telegram Bot updates (/start, /quota, /status, /reset, inline keyboard callbacks).
- GET /setup-webhook: Quick helper to register webhook with Telegram Bot API in 1 click.

---

## Deployment Instructions

### 1. Create Telegram Bot
1. Open [@BotFather](https://t.me/BotFather) on Telegram.
2. Send /newbot and name it (e.g. Timbre Lossless Bot, username TimbreLosslessBot).
3. Copy the Bot API Token (e.g. 123456789:ABC...).

### 2. Configure Cloudflare
1. Login to Cloudflare CLI:
   `ash
   npx wrangler login
   `
2. Create Cloudflare D1 Database (if not already created):
   `ash
   npx wrangler d1 create timbre-db
   `
   Copy the database_id output into wrangler.toml.

3. Initialize the database schema:
   `ash
   npm run db:init-remote
   `

4. Set your Telegram Bot Token secret:
   `ash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   `

5. Deploy the worker:
   `ash
   npm run deploy
   `

6. Register the Telegram Webhook:
   Visit: https://<your-worker-subdomain>.workers.dev/setup-webhook
   You will receive {"webhookUrl":"...","telegram":{"ok":true}}.
