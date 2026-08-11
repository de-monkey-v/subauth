import { createHash, randomBytes } from "node:crypto";

/** Base64url with no padding — the encoding PKCE and JWT segments both use. */
export function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Generate an RFC 7636 PKCE pair.
 *
 * The verifier is 32 random bytes rendered as base64url, which lands on exactly
 * 43 characters — the RFC's minimum length — drawn from `[A-Za-z0-9-_]`, a
 * subset of the unreserved set the spec allows.
 *
 * This differs from the common `alphabet[byte % alphabet.length]` idiom on
 * purpose. That idiom is only uniform when the alphabet size divides 256, and
 * the full unreserved set is 66 characters (26 + 26 + 10 + `-._~`), so 58 of
 * the 66 characters come up slightly more often. Encoding the bytes directly
 * removes the bias instead of reasoning about whether it matters.
 */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
