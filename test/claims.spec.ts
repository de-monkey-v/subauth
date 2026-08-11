import { describe, expect, it } from "vitest";
import { extractAccountId } from "../src/claims";

/** Build an unsigned JWT-shaped string; only the payload segment is ever read. */
function jwt(payload: unknown): string {
  const head = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.signature`;
}

describe("extractAccountId", () => {
  it("reads a top-level chatgpt_account_id", () => {
    const id_token = jwt({ chatgpt_account_id: "acct-top" });
    expect(extractAccountId({ id_token })).toBe("acct-top");
  });

  it("falls back to the namespaced auth claim", () => {
    const id_token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-ns" } });
    expect(extractAccountId({ id_token })).toBe("acct-ns");
  });

  it("falls back to the first organization id", () => {
    const id_token = jwt({ organizations: [{ id: "org-1" }, { id: "org-2" }] });
    expect(extractAccountId({ id_token })).toBe("org-1");
  });

  it("prefers the id token over the access token", () => {
    expect(
      extractAccountId({
        id_token: jwt({ chatgpt_account_id: "from-id" }),
        access_token: jwt({ chatgpt_account_id: "from-access" }),
      }),
    ).toBe("from-id");
  });

  it("uses the access token when a refresh response omits the id token", () => {
    expect(extractAccountId({ access_token: jwt({ chatgpt_account_id: "from-access" }) })).toBe(
      "from-access",
    );
  });

  it("returns undefined for missing, malformed, or claimless tokens", () => {
    expect(extractAccountId({})).toBeUndefined();
    expect(extractAccountId({ id_token: "not-a-jwt" })).toBeUndefined();
    expect(extractAccountId({ id_token: "a.!!!not-base64!!!.c" })).toBeUndefined();
    expect(extractAccountId({ id_token: jwt({ sub: "user-1" }) })).toBeUndefined();
    expect(extractAccountId({ id_token: jwt({ organizations: [] }) })).toBeUndefined();
  });
});
