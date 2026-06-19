/**
 * ADR-046 — rough cost estimation for prompt-driven summary generation.
 *
 * Rates are approximate $/M-tokens listed on OpenRouter as of mid-2026.
 * Used only to surface "est. $X" in the regen CTA — actual billing
 * comes from OpenRouter's invoice. Off by 2x is fine here; the goal
 * is "don't spend $400 by accident".
 */

interface ModelRate {
  inputPerMTok: number;   // $ per 1M input tokens
  outputPerMTok: number;  // $ per 1M output tokens
}

const MODEL_RATES: Record<string, ModelRate> = {
  "google/gemini-2.5-pro":             { inputPerMTok: 1.25,  outputPerMTok: 5.00 },
  "google/gemini-2.5-flash":           { inputPerMTok: 0.075, outputPerMTok: 0.30 },
  "google/gemini-2.0-flash-001":       { inputPerMTok: 0.075, outputPerMTok: 0.30 },
  "anthropic/claude-opus-4.7":         { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  "anthropic/claude-sonnet-4.6":       { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  "anthropic/claude-haiku-4-5":        { inputPerMTok: 0.80,  outputPerMTok: 4.00 },
  "openai/gpt-5":                       { inputPerMTok: 5.00,  outputPerMTok: 20.00 },
};

const DEFAULT_RATE: ModelRate = { inputPerMTok: 3.00, outputPerMTok: 15.00 };
const CHARS_PER_TOKEN = 3.5;
const EXPECTED_OUTPUT_TOKENS = 4000;  // typical summary length per record

export function getModelRate(model: string): ModelRate {
  return MODEL_RATES[model] ?? DEFAULT_RATE;
}

export function isKnownModel(model: string): boolean {
  return model in MODEL_RATES;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Estimated $ to summarise a record with the given transcript size and model. */
export function estimatePerRecordCost(transcriptChars: number, model: string, chatChars: number = 0): number {
  const rate = getModelRate(model);
  const inputTokens = estimateTokens(transcriptChars + chatChars);
  return (inputTokens / 1_000_000) * rate.inputPerMTok
       + (EXPECTED_OUTPUT_TOKENS / 1_000_000) * rate.outputPerMTok;
}

/** Aggregate cost over many records — used for the bulk-regen preview. */
export function estimateBatchCost(items: Array<{ transcript_chars: number; chat_chars?: number }>, model: string): number {
  return items.reduce((sum, item) => sum + estimatePerRecordCost(item.transcript_chars, model, item.chat_chars ?? 0), 0);
}

export function formatUsd(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}
