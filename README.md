# subauth

Use a personal ChatGPT subscription as an OpenAI-compatible credential.

`sub`scription `auth` — the thing this package does that an API-key helper does
not. It runs the ChatGPT OAuth flow, keeps the token fresh, and hands you a
`fetch` that the Codex backend accepts. What you do with that fetch is yours:
plug it into an AI SDK provider, or call the API directly.

> [!WARNING]
> **Personal, single-account use only.** A ChatGPT subscription is licensed for
> one person's own use. Routing other people's requests through one subscription
> violates the ChatGPT terms. See [docs/personal-use.md](docs/personal-use.md) —
> this is not hypothetical: Anthropic prohibited the equivalent pattern for
> Claude subscriptions on 2026-02-20 and third-party tools relying on it broke.

## Install

Not published to npm, by design — see [personal use](docs/personal-use.md). That
is enforced, not just intended: `package.json` carries `"private": true`, so
`npm publish` refuses. Installing from a git tag is unaffected.

```bash
pnpm add github:de-monkey-v/subauth#v0.4.0
```

`dist/` is committed, so installation needs no build step and no build-script
approval.

## Use

```ts
import { createChatGPTAuth, createCodexFetch, fileTokenStore } from "subauth";

const auth = createChatGPTAuth({
  store: fileTokenStore("/home/me/.config/myapp/chatgpt-oauth.json"),
});

// A fetch that injects current credentials and the Codex request contract.
const fetch = createCodexFetch(auth);

const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "hello" }),
});
```

### Reusing an existing Codex CLI login

If you already ran `codex login`, there is no second login to do:

```ts
import path from "node:path";
import os from "node:os";
import { codexAuthStore, createChatGPTAuth } from "subauth";

const auth = createChatGPTAuth({
  store: codexAuthStore(
    path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json"),
  ),
});
```

`codexAuthStore` reads and writes the CLI's own file format in place, preserving
everything it does not own — that file also holds an API key and other
providers' credentials, and none of it is this package's to touch.

**Share the file; do not copy it.** Refresh tokens rotate, so two files holding
the same account's credentials invalidate each other the first time either side
refreshes. Pointing both at one file is what lets each observe the other's
rotation — the same property the read-through store contract exists for.

Three things worth knowing:

- **Run `codex login` first.** This adapts an existing CLI session rather than
  creating one. The CLI decodes an id token out of the file, and that field is
  required, so a write without one is refused instead of producing a file the
  CLI cannot read — which would cost it every other credential in there too. By
  the same rule, a file whose id token the CLI could not parse reads back here
  as logged out. To hold a session this package logs into itself, use
  `fileTokenStore` with a path of your own.
- **The format records no expiry**, so the deadline comes from the access
  token's own `exp` claim. A token that is not a decodable JWT is treated as
  logged out rather than assumed fresh. An API-key-mode file (`tokens: null`)
  likewise reads as logged out.
- **`logout()` removes only the ChatGPT session**, leaving the API key and other
  entries in place — after which the CLI falls back to that key. It is also
  called automatically when a refresh token turns out to be revoked, which is
  why it must neither delete the file nor throw.

Three limits worth knowing before you rely on this:

- **No file lock.** Under deliberate contention roughly 0.15–0.25% of writes
  overwrite one the CLI made in the same instant. Both sides re-read on the next
  refresh, but if the lost write was a *rotation*, the surviving token is
  already dead and the next call needs a login.
- **A failed write costs the stored session.** The server rotates the refresh
  token before the write is attempted, so if saving fails — full disk, read-only
  directory — the rotated token is gone. The current process keeps working with
  its access token and a warning is logged; the next one has to log in again.
  This is inherent to rotation, not specific to this store.
- **A lost rotation race surfaces as a repeated error, not a logout.** When two
  processes refresh at once the loser waits for the winner's write and adopts
  it. If the winner is slower than that wait, the loser gives up and throws
  `InvalidGrantError` — it does **not** clear the store, because the winner may
  still be about to save a perfectly good token, and clearing would make it
  discard that token instead. So a spent refresh token can sit on disk producing
  the same error until someone writes over it or calls `logout()`. That is the
  deliberate trade: a repeated, coded error beats silently losing a live login.

Logging in, once, from a CLI:

```ts
import { loginWithBrowser } from "subauth/login";

const status = await loginWithBrowser({
  store,
  onVerificationUrl: (url) => console.log(`Open this to log in:\n${url}`),
});
console.log(`logged in as ${status.accountId}`);
```

For headless hosts and web UIs, `auth.startDeviceAuth()` / `auth.pollDeviceToken()`
run the device-code flow instead.

### With the AI SDK

The provider factory is a parameter, not an import — that is what keeps this
package dependency-free and lets you stay on whatever `@ai-sdk/openai` major you
already use.

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { createChatGPTOpenAIProvider } from "subauth/ai-sdk";
import { streamText } from "ai";

const provider = createChatGPTOpenAIProvider({ auth, createOpenAI });

const result = streamText({
  model: provider.responses("gpt-5.6-sol"),
  prompt: "hello",
});
```

Two constraints the Codex backend imposes, which you inherit:

- **Use `.responses(...)`.** It serves the Responses API, not chat completions.
- **Stream.** It rejects non-streaming requests with `Stream must be set to
  true`, so `generateText`/`generateObject` fail against it. Use `streamText`/
  `streamObject` and read the aggregate afterwards.

Model ids are limited to what your plan exposes — an id your plan does not
carry comes back as `model is not supported`.

## API

| Export | Purpose |
| --- | --- |
| `createChatGPTAuth(options)` | Session handle: `getFreshAccess`, `status`, `exists`, `logout`, device flow |
| `createCodexFetch(auth, options?)` | `fetch` wrapper that injects credentials and the Codex request contract |
| `fileTokenStore(path)` / `memoryTokenStore(initial?)` | Token persistence |
| `codexAuthStore(path)` | Token persistence in the Codex CLI's own `auth.json` format |
| `providerOf(modelId)` | Model id → `"openai" \| "anthropic" \| "google" \| null` |
| `subauth/login` → `loginWithBrowser` | Loopback PKCE browser login |
| `subauth/ai-sdk` → `createChatGPTOpenAIProvider` | AI SDK provider bridge |

Errors carry a stable `code` (`not_authenticated`, `refresh_token_missing`,
`invalid_grant`, `token_request_failed`, `device_auth_failed`, `login_failed`);
branch on that rather than on message text.

### Design notes

**No default token path, and no environment variables.** Where credentials live
is application policy. `fileTokenStore` takes the path; nothing here reads
`process.env`.

**`TokenStore` is synchronous**, because consumers call `exists()` from
synchronous configuration paths. `read()` must be read-through — the recovery
path for a lost refresh-token rotation depends on observing what another process
just wrote, and a caching store silently disables it. An async store backend
would be a breaking change.

**`getFreshAccess()` is the only export that returns a token.** `status()`
returns metadata, and `loginWithBrowser` returns status rather than the session
it stored.

**No user dimension, by design.** `createChatGPTAuth` takes one store. There is
no `userId` parameter and no multi-store registry, because this is not a package
for serving other people's requests from one subscription.

**No dependencies** — not even peer dependencies. Everything external is
injected: `fetch`, the clock, sleep, the logger, the browser launcher, and the
AI SDK provider factory.

## Develop

```bash
pnpm install
pnpm verify      # typecheck → build → unit tests → consumer checks
```

`dist/` is committed, so rebuild and include it in the same commit as any source
change: `pnpm build && git diff --exit-code dist` must be clean before tagging.

The consumer checks under `test/consumer/` run the built package from separate
processes — CommonJS `require`, ESM `import`, and a node10/`lib: ["ES2022"]`
TypeScript project — because that is what the unit tests structurally cannot
cover.

`pnpm verify` never touches your Codex login. Two of those checks (AC8, AC9) can
only answer their question against a real `auth.json`, so they skip unless you
ask for them:

```bash
SUBAUTH_LIVE_CODEX=1 pnpm test:consumer
```

Opted in, AC8 reads a copy of `~/.codex/auth.json` and asserts the original is
byte-identical afterwards, and AC9 additionally starts a real `codex` process
against that copy. AC9 skips on its own when the session is within an hour of
expiry, since a refresh triggered there would rotate the token out from under the
original file.

## License

MIT
