import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChatGPTAuth } from "../src/auth";
import { StoreWriteRefusedError } from "../src/errors";
import { toTokens } from "../src/protocol";
import { codexAuthStore } from "../src/store-codex";
import { fileTokenStore } from "../src/store-file";
import type { OAuthTokens } from "../src/types";

const NOW = 1_800_000_000_000;
const EXP_SECONDS = 1_800_003_600; // NOW + 1h, in seconds

/** Build an unsigned JWT; only the payload is ever read. */
function jwt(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.signature`;
}

const ACCESS = jwt({ exp: EXP_SECONDS, chatgpt_account_id: "acct-jwt" });

/** The shape the Codex CLI actually writes. */
function codexFile(over: Record<string, unknown> = {}) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({ chatgpt_account_id: "acct-1" }),
      access_token: ACCESS,
      refresh_token: "refresh-1",
      account_id: "acct-1",
    },
    last_refresh: "2026-08-11T03:19:09.878Z",
    ...over,
  };
}

describe("codexAuthStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "subauth-codex-"));
    file = path.join(dir, "auth.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads an existing Codex CLI session without re-authentication", () => {
    const start = codexFile();
    writeFileSync(file, JSON.stringify(start));
    const store = codexAuthStore(file, { now: () => NOW });

    expect(store.read()).toEqual({
      access: ACCESS,
      refresh: "refresh-1",
      accountId: "acct-1",
      // Carried so a write can keep it in step with the credentials it identifies.
      idToken: start.tokens.id_token,
      // This format records no expiry of its own; it comes from the JWT.
      expires: EXP_SECONDS * 1000,
    });
    expect(store.exists()).toBe(true);
  });

  it("reports no account id only when neither the field nor any claim has one", () => {
    const bare = codexFile();
    delete (bare.tokens as Record<string, unknown>)["account_id"];
    delete (bare.tokens as Record<string, unknown>)["id_token"];
    bare.tokens.access_token = jwt({ exp: EXP_SECONDS });
    writeFileSync(file, JSON.stringify(bare));

    expect(codexAuthStore(file).read()?.accountId).toBeUndefined();
  });

  it("preserves the fields the CLI owns when writing back", () => {
    writeFileSync(file, JSON.stringify(codexFile({ future_field: { nested: true } })));
    const store = codexAuthStore(file, { now: () => NOW });

    const rotated: OAuthTokens = {
      access: jwt({ exp: EXP_SECONDS + 3600 }),
      refresh: "refresh-2",
      accountId: "acct-1",
      expires: (EXP_SECONDS + 3600) * 1000,
    };
    store.write(rotated);

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    // Ours to change.
    expect(onDisk["tokens"]["access_token"]).toBe(rotated.access);
    expect(onDisk["tokens"]["refresh_token"]).toBe("refresh-2");
    // The CLI's to keep — dropping these would break it against the same file.
    expect(onDisk["auth_mode"]).toBe("chatgpt");
    expect(onDisk["tokens"]["id_token"]).toBeTruthy();
    expect(onDisk["future_field"]).toEqual({ nested: true });
    // Refreshed bookkeeping.
    expect(onDisk["last_refresh"]).toBe(new Date(NOW).toISOString());
  });

  it("round-trips through its own read", () => {
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file, { now: () => NOW });
    const next = jwt({ exp: EXP_SECONDS + 7200 });
    const nextId = jwt({ chatgpt_account_id: "acct-9" });

    store.write({
      access: next,
      refresh: "refresh-2",
      accountId: "acct-9",
      idToken: nextId,
      expires: 0,
    });

    expect(store.read()).toEqual({
      access: next,
      refresh: "refresh-2",
      accountId: "acct-9",
      idToken: nextId,
      // Re-derived from the new access token, not from what was passed in.
      expires: (EXP_SECONDS + 7200) * 1000,
    });
  });

  it("writes owner-only and leaves no temp file", () => {
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file, { now: () => NOW });
    store.write({ access: ACCESS, refresh: "r", idToken: jwt({}), expires: 0 });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("reads through to disk so the CLI's own refresh is observed", () => {
    // The whole reason for sharing the file rather than copying it.
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file);
    expect(store.read()?.refresh).toBe("refresh-1");

    const afterCli = codexFile();
    afterCli.tokens.refresh_token = "rotated-by-cli";
    writeFileSync(file, JSON.stringify(afterCli));

    expect(store.read()?.refresh).toBe("rotated-by-cli");
  });

  it("uses the same key as fileTokenStore for the same path", () => {
    // Concurrent refreshes are de-duplicated per key, so two stores over one
    // file must agree on identity or they would rotate each other out.
    expect(codexAuthStore(file).key).toBe(fileTokenStore(file).key);
  });

  it("collapses concurrent refreshes across separately constructed stores", async () => {
    // A consumer can build the store twice — two modules, two auth objects,
    // one file. Both must share a single rotation, or the second exchange is
    // rejected as refresh-token reuse and the session is revoked.
    const expiring = codexFile();
    expiring.tokens.access_token = jwt({ exp: NOW / 1000 });
    writeFileSync(file, JSON.stringify(expiring));

    let calls = 0;
    const options = {
      fetch: async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({
            access_token: jwt({ exp: EXP_SECONDS }),
            refresh_token: "refresh-rotated",
            expires_in: 3600,
          }),
        };
      },
      now: () => NOW,
      sleep: async () => {},
    };

    const [a, b] = await Promise.all([
      createChatGPTAuth({ ...options, store: codexAuthStore(file, { now: () => NOW }) }).getFreshAccess(),
      createChatGPTAuth({ ...options, store: codexAuthStore(file, { now: () => NOW }) }).getFreshAccess(),
    ]);

    expect(calls).toBe(1);
    expect(a.access).toBe(b.access);
    expect(codexAuthStore(file).read()?.refresh).toBe("refresh-rotated");
  });

  it("clears the session without deleting the file", () => {
    // A typical file holds only auth_mode/tokens/last_refresh, so "delete when
    // nothing else remains" would delete the common case — and a concurrent CLI
    // refresh landing just before it would lose a live token.
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file);

    store.clear();

    expect(store.exists()).toBe(false);
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    expect(onDisk["tokens"]).toBeNull();
    // auth_mode goes with the session: leaving "chatgpt" beside a null token
    // makes the CLI report a login whose every request 401s, and blocks its
    // fallback to an API key in the same file.
    expect(onDisk["auth_mode"]).toBeUndefined();
    expect(() => store.clear()).not.toThrow();
  });

  it("keeps other credentials when clearing a shared file", () => {
    // clear() runs automatically when a refresh token turns out to be revoked.
    // This file also carries an API key and other providers' material, so
    // deleting it wholesale would destroy credentials we never touched.
    writeFileSync(
      file,
      JSON.stringify(
        codexFile({
          OPENAI_API_KEY: "sk-user-key",
          bedrock_api_key: "bedrock-key",
          agent_identity: { id: "agent-1" },
        }),
      ),
    );
    const store = codexAuthStore(file);

    store.clear();

    expect(store.exists()).toBe(false);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    expect(onDisk["OPENAI_API_KEY"]).toBe("sk-user-key");
    expect(onDisk["bedrock_api_key"]).toBe("bedrock-key");
    expect(onDisk["agent_identity"]).toEqual({ id: "agent-1" });
    // Only the ChatGPT session is gone.
    expect(onDisk["tokens"]).toBeNull();
  });

  it("never writes a refresh token its own read would reject", () => {
    // toTokens can yield an empty refresh when a login response omits the
    // field. Persisting that would overwrite the CLI's live refresh token with
    // nothing, logging both programs out with no way back.
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file, { now: () => NOW });

    store.write({ access: ACCESS, refresh: "", accountId: "acct-1", expires: 0 });

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    expect(onDisk["tokens"]["refresh_token"]).toBe("refresh-1");
    expect(store.read()).not.toBeNull();
  });

  it("refuses when there is no refresh token to fall back on either", () => {
    const fresh = path.join(dir, "empty", "auth.json");
    const store = codexAuthStore(fresh, { now: () => NOW });
    expect(() =>
      store.write({ access: ACCESS, refresh: "", idToken: jwt({}), expires: 0 }),
    ).toThrow(StoreWriteRefusedError);
  });

  it("replaces the id token when the account changes", () => {
    // Preserving it blindly leaves the previous account's identity sitting next
    // to the new account's credentials, and the CLI reads identity from there.
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file, { now: () => NOW });

    const newIdToken = jwt({ chatgpt_account_id: "acct-NEW" });
    store.write({
      access: ACCESS,
      refresh: "refresh-new",
      accountId: "acct-NEW",
      idToken: newIdToken,
      expires: 0,
    });

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    expect(onDisk["tokens"]["id_token"]).toBe(newIdToken);
    expect(onDisk["tokens"]["account_id"]).toBe("acct-NEW");
  });

  it("refuses to write a different account's session with no id token of its own", () => {
    // Keeping the old id token would make the CLI report the wrong identity;
    // dropping it makes the CLI unable to parse the file at all, taking every
    // other credential in it down too. Refusing leaves a working file behind.
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file, { now: () => NOW });
    const before = readFileSync(file, "utf8");

    expect(() =>
      store.write({ access: ACCESS, refresh: "refresh-new", accountId: "acct-OTHER", expires: 0 }),
    ).toThrow(StoreWriteRefusedError);

    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses to create a file the CLI could not parse", () => {
    const fresh = path.join(dir, "new", "auth.json");
    const store = codexAuthStore(fresh, { now: () => NOW });

    expect(() => store.write({ access: ACCESS, refresh: "r", accountId: "a", expires: 0 })).toThrow(
      StoreWriteRefusedError,
    );
    expect(existsSync(fresh)).toBe(false);
  });

  it("preserves unknown fields inside tokens", () => {
    // The CLI may add fields there; whitelisting four keys would delete them.
    const withExtra = codexFile();
    (withExtra.tokens as Record<string, unknown>)["refresh_token_expires_at"] = 123;
    writeFileSync(file, JSON.stringify(withExtra));
    const store = codexAuthStore(file, { now: () => NOW });

    store.write({ access: ACCESS, refresh: "refresh-new", accountId: "acct-1", expires: 0 });

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    expect(onDisk["tokens"]["refresh_token_expires_at"]).toBe(123);
  });

  it("follows a symlink instead of replacing it", () => {
    // A rename would swap the link for a regular file, splitting one account's
    // rotating credentials across two locations.
    const target = path.join(dir, "real-auth.json");
    const link = path.join(dir, "link-auth.json");
    writeFileSync(target, JSON.stringify(codexFile()));
    symlinkSync(target, link);

    const store = codexAuthStore(link, { now: () => NOW });
    store.write({ access: ACCESS, refresh: "refresh-new", accountId: "acct-1", expires: 0 });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const onDisk = JSON.parse(readFileSync(target, "utf8")) as Record<string, any>;
    expect(onDisk["tokens"]["refresh_token"]).toBe("refresh-new");
    expect(store.key).toBe(realpathSync(target));
  });

  it("keeps the id token when the account is unchanged", () => {
    const start = codexFile();
    writeFileSync(file, JSON.stringify(start));
    const store = codexAuthStore(file, { now: () => NOW });

    store.write({ access: ACCESS, refresh: "refresh-new", accountId: "acct-1", expires: 0 });

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    expect(onDisk["tokens"]["id_token"]).toBe(start.tokens.id_token);
  });

  it("recovers the account id from claims when the field is absent", () => {
    // Without an account id the backend rejects requests with no useful signal.
    // The id token here carries no account claim, so the value can only come
    // from the access token — which is the fallback under test.
    const noField = codexFile();
    delete (noField.tokens as Record<string, unknown>)["account_id"];
    (noField.tokens as Record<string, unknown>)["id_token"] = jwt({ exp: EXP_SECONDS });
    writeFileSync(file, JSON.stringify(noField));

    expect(codexAuthStore(file).read()?.accountId).toBe("acct-jwt");
  });

  // read() and write() have to accept the same files. write() refuses an id
  // token the CLI cannot parse, and a refresh response does not always carry a
  // replacement, so a session read from such a file would refresh — rotating
  // the token server-side — and then fail to persist it. The rotation would be
  // lost while the disk kept the retired token: strictly worse than logged out.
  for (const [label, value] of [
    ["absent", undefined],
    ["not a JWT", "not-a-jwt"],
    ["two segments", "aaa.bbb"],
  ] as Array<[string, string | undefined]>) {
    it(`reports logged out when the id token is ${label}`, () => {
      const broken = codexFile();
      if (value === undefined) delete (broken.tokens as Record<string, unknown>)["id_token"];
      else (broken.tokens as Record<string, unknown>)["id_token"] = value;
      writeFileSync(file, JSON.stringify(broken));

      const store = codexAuthStore(file);
      expect(store.read()).toBeNull();
      expect(store.exists()).toBe(false);
    });
  }

  it("treats an API-key-mode file as logged out", () => {
    writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: "sk-x", auth_mode: "apikey", tokens: null }));
    const store = codexAuthStore(file);
    expect(store.read()).toBeNull();
    expect(store.exists()).toBe(false);
  });

  it("keeps working when destructured", () => {
    writeFileSync(file, JSON.stringify(codexFile()));
    const { read, exists } = codexAuthStore(file);
    expect(exists()).toBe(true);
    expect(read()?.refresh).toBe("refresh-1");
  });
});

describe("codexAuthStore — unusable files", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "subauth-codex-bad-"));
    file = path.join(dir, "auth.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const unusable: Array<[string, string]> = [
    ["missing file", ""],
    ["empty file", ""],
    ["not json", "<html>nope</html>"],
    ["json array", "[]"],
    ["json null", "null"],
    ["no tokens object", JSON.stringify({ auth_mode: "chatgpt" })],
    ["no access token", JSON.stringify({ tokens: { refresh_token: "r" } })],
    ["no refresh token", JSON.stringify({ tokens: { access_token: ACCESS } })],
    ["empty access token", JSON.stringify({ tokens: { access_token: "", refresh_token: "r" } })],
    [
      "access token is not a JWT",
      JSON.stringify({ tokens: { access_token: "opaque-token", refresh_token: "r" } }),
    ],
    [
      "access token has no exp claim",
      JSON.stringify({ tokens: { access_token: jwt({ sub: "u" }), refresh_token: "r" } }),
    ],
    [
      "exp is not a number",
      JSON.stringify({ tokens: { access_token: jwt({ exp: "soon" }), refresh_token: "r" } }),
    ],
  ];

  for (const [label, content] of unusable) {
    it(`treats "${label}" as logged out rather than throwing`, () => {
      if (label !== "missing file") writeFileSync(file, content);
      const store = codexAuthStore(file);

      expect(() => store.read()).not.toThrow();
      expect(store.read()).toBeNull();
      expect(store.exists()).toBe(false);
    });
  }
});

describe("codexAuthStore — second verification round", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "subauth-codex-v2-"));
    file = path.join(dir, "auth.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an id token of the wrong type, not just a missing one", () => {
    // The CLI's record is typed: `id_token: 12345` fails to parse just as hard
    // as no id_token at all, taking the whole file with it.
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file, { now: () => NOW });
    const before = readFileSync(file, "utf8");

    expect(() =>
      store.write({
        access: ACCESS,
        refresh: "r",
        accountId: "acct-1",
        idToken: 12345 as unknown as string,
        expires: 0,
      }),
    ).toThrow(StoreWriteRefusedError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  // The CLI does not store `id_token` opaquely — it decodes it, and the field is
  // neither optional nor defaulted. A non-empty string that is not a JWT
  // therefore fails exactly like a missing one, taking `OPENAI_API_KEY` and
  // every other credential in the file down with it.
  const unparseable: Array<[string, string]> = [
    ["not a JWT at all", "not-a-jwt"],
    ["two segments", "aaa.bbb"],
    ["three segments with an empty middle", "aaa..ccc"],
    ["three segments whose payload is not base64url JSON", "aaa.bbb.ccc"],
  ];

  for (const [label, idToken] of unparseable) {
    it(`refuses an id token that is ${label}`, () => {
      writeFileSync(file, JSON.stringify(codexFile()));
      const store = codexAuthStore(file, { now: () => NOW });
      const before = readFileSync(file, "utf8");

      expect(() =>
        store.write({ access: ACCESS, refresh: "r", accountId: "acct-1", idToken, expires: 0 }),
      ).toThrow(StoreWriteRefusedError);
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  }

  it("still writes an id token the CLI can parse", () => {
    // The negative control for the four cases above: the guard has to reject
    // unparseable tokens without also rejecting real ones.
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file, { now: () => NOW });
    const parseable = jwt({ exp: EXP_SECONDS, chatgpt_account_id: "acct-1" });

    store.write({ access: ACCESS, refresh: "r", accountId: "acct-1", idToken: parseable, expires: 0 });

    expect(JSON.parse(readFileSync(file, "utf8")).tokens.id_token).toBe(parseable);
  });

  it("clears without throwing when the file cannot be rewritten", () => {
    // clear() runs from a path already handling an invalid_grant. Throwing here
    // would replace that error with a filesystem one and break the `code` a
    // consumer branches on.
    writeFileSync(file, JSON.stringify(codexFile()));
    const store = codexAuthStore(file, { now: () => NOW });
    chmodSync(dir, 0o500);
    try {
      expect(() => store.clear()).not.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("does not carry an id token across an account change on refresh", () => {
    // toTokens inherits from the previous session; inheriting identity along
    // with credentials would pair one account's id token with another's tokens.
    const previous: OAuthTokens = {
      access: "old",
      refresh: "r",
      accountId: "acct-OLD",
      idToken: jwt({ chatgpt_account_id: "acct-OLD" }),
      expires: 0,
    };
    const forOther = toTokens(
      { access_token: jwt({ chatgpt_account_id: "acct-NEW", exp: EXP_SECONDS }), expires_in: 3600 },
      () => NOW,
      previous,
    );

    expect(forOther.accountId).toBe("acct-NEW");
    expect(forOther.idToken).toBeUndefined();
  });

  it("keeps inheriting the id token when the account is unchanged", () => {
    const previous: OAuthTokens = {
      access: "old",
      refresh: "r",
      accountId: "acct-1",
      idToken: jwt({ chatgpt_account_id: "acct-1" }),
      expires: 0,
    };
    const refreshed = toTokens(
      { access_token: jwt({ chatgpt_account_id: "acct-1", exp: EXP_SECONDS }), expires_in: 3600 },
      () => NOW,
      previous,
    );

    expect(refreshed.idToken).toBe(previous.idToken);
  });
});
