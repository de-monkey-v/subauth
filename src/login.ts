/**
 * subauth/login — interactive browser login.
 *
 * ⚠️ Personal, single-account use only — see docs/personal-use.md.
 *
 * Kept out of the root entry because it pulls in `node:http` (loopback callback
 * server) and `node:child_process` (opening the browser), which server bundlers
 * should not have to reason about when a consumer only needs token refresh.
 */

export { loginWithBrowser, openSystemBrowser } from "./browser-login";
export type { BrowserLoginOptions } from "./browser-login";
