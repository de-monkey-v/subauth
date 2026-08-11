import { describe, expect, it } from "vitest";
import { providerOf } from "../src/model-id";

describe("providerOf", () => {
  it("recognizes OpenAI model ids", () => {
    for (const id of ["gpt-5.6-sol", "gpt-4o", "GPT-5", "o1-preview", "o3-mini"]) {
      expect(providerOf(id)).toBe("openai");
    }
  });

  it("recognizes Anthropic model ids", () => {
    expect(providerOf("claude-opus-5")).toBe("anthropic");
    expect(providerOf("claude-haiku-4-5-20251001")).toBe("anthropic");
  });

  it("recognizes Google model ids", () => {
    expect(providerOf("gemini-3-pro")).toBe("google");
  });

  it("matches case-insensitively for every vendor, not just OpenAI", () => {
    // `GPT-5` resolved while `Claude-opus-5` returned null, so a capitalized id
    // failed to route for one vendor and not the other.
    expect(providerOf("Claude-opus-5")).toBe("anthropic");
    expect(providerOf("Gemini-3-pro")).toBe("google");
    expect(providerOf("GPT-5")).toBe("openai");
    expect(providerOf("O3-mini")).toBe("openai");
  });

  it("returns null rather than guessing for unknown or empty ids", () => {
    // A caller that cannot identify the provider should say so, not route a
    // typo to whichever backend happens to be checked first.
    for (const id of ["", "llama-3", "mistral-large", "unknown"]) {
      expect(providerOf(id)).toBeNull();
    }
  });
});
