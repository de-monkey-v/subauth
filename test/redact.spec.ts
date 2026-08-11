import { describe, expect, it } from "vitest";
import { REDACTED, scrubDetail, scrubSecrets } from "../src/redact";

const JWT_SAMPLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LTEyMyJ9.c2lnbmF0dXJlLWJ5dGVz";
const REFRESH_SAMPLE = "rt_9fJk2LmNpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWx";

describe("scrubSecrets", () => {
  it("redacts a JWT anywhere in the text", () => {
    const out = scrubSecrets(`token was ${JWT_SAMPLE} sadly`);
    expect(out).not.toContain(JWT_SAMPLE);
    expect(out).not.toContain("eyJ");
    expect(out).toContain(REDACTED);
    expect(out).toContain("token was");
  });

  it("redacts a JSON credential field but keeps the key name readable", () => {
    const out = scrubSecrets(`{"refresh_token":"${REFRESH_SAMPLE}","expires_in":3600}`);
    expect(out).not.toContain(REFRESH_SAMPLE);
    expect(out).toContain('"refresh_token"');
    expect(out).toContain("expires_in");
    expect(out).toContain("3600");
  });

  it("redacts form-encoded credential fields", () => {
    const out = scrubSecrets(`grant_type=refresh_token&refresh_token=${REFRESH_SAMPLE}&client_id=app_x`);
    expect(out).not.toContain(REFRESH_SAMPLE);
    expect(out).toContain("grant_type=");
    expect(out).toContain("client_id=app_x");
  });

  it("redacts bearer tokens while keeping the scheme", () => {
    const out = scrubSecrets(`Authorization: Bearer ${REFRESH_SAMPLE}`);
    expect(out).not.toContain(REFRESH_SAMPLE);
    expect(out).toContain("Bearer");
    expect(out).toContain(REDACTED);
  });

  it("redacts OpenAI-style api keys", () => {
    const key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    expect(scrubSecrets(`key ${key} used`)).not.toContain(key);
  });

  it("redacts long opaque blobs of unknown shape", () => {
    const opaque = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A";
    expect(scrubSecrets(opaque)).toBe(REDACTED);
  });

  it("keeps short diagnostic text intact", () => {
    const text = "token request failed (400): invalid_request, model gpt-5.6-sol";
    expect(scrubSecrets(text)).toBe(text);
  });

  it("returns empty string for non-string input", () => {
    expect(scrubSecrets(undefined as unknown as string)).toBe("");
    expect(scrubSecrets("")).toBe("");
  });
});

describe("scrubDetail", () => {
  it("scrubs before truncating so a halved token is still removed", () => {
    // Truncation alone would leave the first 30 characters of the token behind.
    const body = `{"refresh_token":"${REFRESH_SAMPLE}"}`;
    const out = scrubDetail(body, 30);
    expect(out).not.toContain(REFRESH_SAMPLE.slice(0, 20));
  });

  it("truncates long scrubbed output", () => {
    // Spaced words survive scrubbing, so what is measured here is truncation
    // rather than the opaque-blob rule collapsing the input to one marker.
    const out = scrubDetail("upstream said no ".repeat(50), 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses a long unbroken blob rather than truncating it", () => {
    // Documents the aggressive side of the 40-char opaque rule: any long
    // single token is treated as credential material, readability second.
    expect(scrubDetail("x".repeat(500), 100)).toBe(REDACTED);
  });
});
