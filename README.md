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

Not published to npm, by design — see [personal use](docs/personal-use.md).

```bash
pnpm add github:gyuhyeonLee/subauth#v0.1.0
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

## License

MIT
