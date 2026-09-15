/* ==========================================================================
   gherkin-ai-cli - Token Estimator & Prompt Optimization Helper
   ========================================================================== */

export interface TokenStats {
  characters: number;
  words: number;
  estimatedTokens: number;
  tokenSavingsPercentage: number;
}

/**
 * Estimates BPE tokens for OpenAI/Anthropic models (~4 characters per token average in English/code).
 */
export function estimateTokens(text: string, inlineCodeSize?: number): TokenStats {
  const characters = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  
  // Standard BPE estimation: ~4 chars / token for text, ~3.5 chars / token for code
  const baseTokens = Math.ceil(characters / 3.8);

  // If we had pasted full contracts inline instead of @ references
  const rawInlineTokens = baseTokens + (inlineCodeSize ? Math.ceil(inlineCodeSize / 3.8) : 1500);
  const savings = Math.max(0, Math.round(((rawInlineTokens - baseTokens) / rawInlineTokens) * 100));

  return {
    characters,
    words,
    estimatedTokens: baseTokens,
    tokenSavingsPercentage: savings
  };
}
