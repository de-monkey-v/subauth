# Scope and boundaries

## The rule

**One person, one account.** A ChatGPT subscription is licensed for the
subscriber's own use. This package exists to let *you* use *your* subscription
from *your* own tools.

- ✅ You, running your own tools and self-hosted apps against your own
  subscription — including from several of your own machines.
- ⚠️ Other people sending prompts through your server, billed to your
  subscription. That is serving a subscription to third parties, and it is
  outside what the subscription grants. Each person needs to authenticate with
  their own account.
- 🔒 Anything you publish, deploy multi-tenant, or offer to others.

## Why this is enforced structurally, not just documented

The API has no user dimension. `createChatGPTAuth` takes exactly one
`TokenStore`; there is no `userId` parameter, no request-scoped store helper,
and no multi-account registry. Building a multi-tenant service on top of it
requires doing something this package deliberately does not offer.

The package is also not published to npm. A public package that resells
subscription access is exactly the thing providers move against first.

## The precedent

This is not a hypothetical risk.

On **2026-02-20 Anthropic prohibited subscription OAuth authentication for
third-party products**: OAuth tokens from Claude Free, Pro, and Max plans became
unusable outside Claude Code and Claude.ai, and third-party developers were
directed to Console-issued API keys. Tools that had routed user requests through
personal subscriptions stopped working.

OpenAI has not made an equivalent announcement, but the mechanism here is the
same shape, so treat that path as revocable.

## What this depends on, and what breaks if it changes

This package authenticates as OpenAI's public Codex client. Two values are
bound to that client id:

- `originator=opencode` on the authorization request
- `originator: codex_cli_rs` on API calls — the backend answers **400** without it

It also targets the ChatGPT backend (`https://chatgpt.com/backend-api/codex`)
rather than `api.openai.com`, because subscription credentials are only accepted
there.

If OpenAI changes the client registration, the originator handling, or the
backend contract, this stops working. Plan for that: keep a standard
`OPENAI_API_KEY` path in your application as a first-class alternative rather
than a fallback you have never exercised. Switching should be a configuration
change, not a migration.

## Operational hygiene

- The token file holds a live refresh token. Keep it at mode `0600`, outside any
  repository, and never in a backup that travels.
- Never commit it. If your store path is inside a repo, add both the file and
  its temp form (`<name>.*.tmp`, from the atomic write) to `.gitignore`.
- Errors from this package are scrubbed before they carry remote output, but
  your own logging around `getFreshAccess()` is yours to keep clean.
- Losing the token file costs one login. Leaking it costs the account.
