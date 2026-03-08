# Cloudflare Email Worker -> Telegram and  Email Forwarder

This project is a Cloudflare Worker that receives inbound emails from Cloudflare Email Routing, extracts a readable message body from MIME content, sends that body to Telegram, and can optionally send an outbound email copy using a `send_email` binding.

## What it does

1. Accepts inbound email events (`email()` handler).
2. Parses MIME headers/body.
3. Prefers `text/plain` parts, falls back to stripped `text/html`.
4. Sends a Telegram message via the Bot API.
5. Optionally sends an email copy using Cloudflare's `EmailMessage` API.

## Project structure

- `src/index.ts`: Worker logic (email parsing, Telegram send, optional email send).
- `wrangler.toml`: Worker config, vars, and `send_email` binding.

## Prerequisites

- Cloudflare account with Workers + Email Routing enabled.
- `wrangler` CLI installed and authenticated.
- A Telegram bot token and a chat ID.
- A verified destination address for outbound email (if using optional email forwarding).

## Configuration

### 1) `wrangler.toml`

Current config in this repo:

```toml
name = "email-tgm"
main = "src/index.ts"
compatibility_date = "2026-03-08"

[vars]
sendEmail = "true"
emailForwardTo = "address@domain.com"

[observability]
enabled = true

[[send_email]]
name = "emailSender"
```

Notes:
- `sendEmail`: toggles optional outbound email copy (`true/false`, accepts `1,true,yes,on`).
- `emailSender`: binding name expected by code (`env.emailSender`).
- `emailForwardTo`: outbound recipient used by code. Set this to the same address allowed by `destination_address`.
- Optional `emailFrom` var is supported by code. If omitted, inbound `message.to` is used as sender.

### 2) Required secrets

Set Telegram credentials as secrets (not plain vars):

```bash
wrangler secret put telegramBotToken
wrangler secret put telegramChatId
```

## Deploy

```bash
wrangler deploy
```

## Connect Email Routing to this Worker

In Cloudflare Dashboard:

1. Go to `Email` -> `Email Routing`.
2. Create (or edit) a route for your address.
3. Choose `Send to Worker`.
4. Select this Worker (`email-tgm` unless renamed).

Once routed, inbound messages trigger the Worker's `email()` handler.

## Runtime behavior

- `fetch()` returns `Email worker is running.` for HTTP checks.
- If Telegram config is missing, inbound email is rejected (`setReject("Misconfigured")`).
- If Telegram send fails, inbound email is rejected.
- If optional outbound email is enabled and send fails, inbound email is rejected.

## Local and remote testing

Basic health check:

```bash
wrangler dev
# open the local URL in browser or curl it
```

Production health check:

```bash
curl "https://<your-worker-subdomain>.workers.dev"
```

Email flow test:

1. Send an email to the routed address.
2. Confirm message arrives in Telegram.
3. If `sendEmail=true`, confirm email copy arrives according to your `send_email` binding configuration.

## Known limitations

- MIME decoding is best-effort and may not perfectly decode all non-ASCII quoted-printable/base64 content.
- Large/complex multipart emails can include attachment sections during parsing.
- Telegram messages are clipped to avoid length limits.

## Troubleshooting

- `Missing telegramBotToken or telegramChatId`: set required secrets.
- `Telegram sending failed`: verify token, chat ID, and bot permissions in the target chat.
- `Email sending failed`: verify `send_email` binding, allowed sender/recipient policy, and destination verification status.
