# AGENTS.md

Repository rules for `subauth`. Project-local rules win over global defaults.

## What this package is

A dependency-free library that turns a personal ChatGPT subscription into an
OpenAI-compatible credential. Extracted from jimi-wiki's inline implementation
so more than one project can use it without duplicating the protocol.

## Invariants

These are not preferences. A change that breaks one of them is wrong.

1. **Zero runtime dependencies.** No `dependencies`, no `peerDependencies`. Node
   builtins only. Anything external — `fetch`, clock, sleep, logger, browser
   launcher, AI SDK provider factory — is injected by the caller.
2. **No ambient environment.** The package reads no environment variable and has
   no default token path. Where credentials live is the consumer's policy.
3. **`getFreshAccess()` is the only export that returns a token.** `status()`
   returns metadata; `loginWithBrowser` returns status. Do not widen this.
4. **Every error message that embeds remote output goes through
   `scrubSecrets`.** The token endpoint receives the refresh token, so an
   echoing endpoint can put a live credential in an error body.
5. **`TokenStore` is synchronous and read-through.** Consumers call `exists()`
   from synchronous paths, and rotation recovery depends on observing another
   process's write. Changing either is a breaking change.
   `codexAuthStore` additionally must preserve every field it does not own and
   must never copy credentials to a second file — two files holding one
   account's tokens revoke each other on the first rotation.
6. **Entry isolation.** `subauth` must not pull in `node:http` or
   `node:child_process`; those belong to `subauth/login`. Enforced by
   `test/dist.spec.ts` and `test/consumer/ac2-entries.mjs`.
7. **No user dimension in the API.** One auth object, one store. See
   `docs/personal-use.md`.
8. **Dual CJS+ESM output with `main`/`module`/`types` kept alongside `exports`.**
   A consumer compiles with `moduleResolution: Node` (node10), which never reads
   the exports map, and without `lib.dom`.

## Development

- Node >= 20, pnpm. `pnpm install --frozen-lockfile`.
- Verification: **`pnpm verify`** (typecheck → build → unit tests → consumer
  checks). Run it before reporting any change complete.
- Unit tests are `test/*.spec.ts` (vitest). `test/setup.ts` replaces global
  `fetch` with a thrower — that is a guard asserting no ambient network access,
  not a mock. Inject test doubles; never reach the network.
- `test/consumer/` holds out-of-process checks against the built package, one
  per acceptance criterion. They are excluded from the root tsconfig on purpose:
  they compile against the *published* package from a directory where `subauth`
  resolves.
- `dist/` **is committed** so `github:` installs need no build step. Rebuild and
  stage it with any source change; `pnpm build && git diff --exit-code dist`
  must be clean before tagging.

## Conventions

- Comments and identifiers in English; conversation with the user in Korean.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Protocol constants (`CLIENT_ID`, both `originator` values, `CODEX_BASE_URL`)
  are bound to OpenAI's public Codex client. They are overridable but their
  defaults are not tuning knobs — changing one without a matching client id
  breaks authentication.

## Releasing

Tags are the distribution mechanism (`vX.Y.Z`), since consumers install by tag.
Before tagging: `pnpm verify`, confirm `dist/` matches the source, and check
that `docs/personal-use.md` still describes reality.
