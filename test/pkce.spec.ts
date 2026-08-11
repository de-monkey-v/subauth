import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64url, generatePKCE } from "../src/pkce";

describe("generatePKCE", () => {
  it("produces a 43-character verifier, the RFC 7636 minimum", () => {
    expect(generatePKCE().verifier).toHaveLength(43);
  });

  it("draws the verifier only from unreserved characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePKCE().verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePKCE();
    const expected = base64url(createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it("emits unpadded base64url in the challenge", () => {
    for (let i = 0; i < 20; i++) {
      expect(generatePKCE().challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never repeats a verifier", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePKCE().verifier));
    expect(seen.size).toBe(200);
  });
});
