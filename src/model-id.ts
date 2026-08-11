/**
 * Single place that maps a model id to its provider.
 *
 * Unknown ids return null rather than guessing a default: a caller that cannot
 * identify the provider should say so explicitly instead of routing a typo to
 * whichever backend happens to be first.
 *
 * This union is additive — new providers may appear in a later version. Pin by
 * tag if an exhaustive `switch` over it must stay exhaustive.
 */
export type Provider = "openai" | "anthropic" | "google";

export function providerOf(model: string): Provider | null {
  if (!model) return null;
  // Case-insensitive throughout: matching `GPT-5` but not `Claude-opus-5`
  // would make routing fail silently for one vendor's capitalized ids.
  const id = model.toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (/^(gpt|o\d)/.test(id)) return "openai";
  if (id.startsWith("gemini")) return "google";
  return null;
}
