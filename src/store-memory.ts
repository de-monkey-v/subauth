import type { OAuthTokens, TokenStore } from "./types";

let counter = 0;

/**
 * In-process token store. Intended for tests and for consumers that manage
 * persistence themselves.
 *
 * Each instance gets a distinct key so two memory stores are never treated as
 * the same account by the refresh de-duplication map.
 */
export function memoryTokenStore(initial: OAuthTokens | null = null): TokenStore {
  let tokens: OAuthTokens | null = initial;
  const key = `memory:${++counter}`;
  return {
    key,
    read: () => tokens,
    write: (next) => {
      tokens = next;
    },
    clear: () => {
      tokens = null;
    },
    exists: () => tokens !== null,
  };
}
