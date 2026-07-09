/**
 * Types for the DeepSeek V3 tokenizer.
 *
 * These mirror the structure of tokenizer.json (HuggingFace tokenizers format).
 */

export interface TokenizerData {
  version: string;
  model: {
    type: 'BPE';
    vocab: Record<string, number>;
    merges: string[];
    dropout: null;
    unk_token: string | null;
    continuing_subword_prefix: string;
    end_of_word_suffix: string;
    fuse_unk: boolean;
    byte_fallback: boolean;
  };
  added_tokens: Array<{
    id: number;
    content: string;
    single_word: boolean;
    lstrip: boolean;
    rstrip: boolean;
    normalized: boolean;
    special: boolean;
  }>;
  normalizer: unknown;
  pre_tokenizer: unknown;
  post_processor: unknown;
  decoder: unknown;
}

/** Token string → ID */
export type VocabMap = Map<string, number>;

/** Merge pair string ("a b") → rank (lower = higher priority) */
export type MergeRanks = Map<string, number>;

/** Parsed tokenizer configuration (internal representation) */
export interface BPEConfig {
  vocab: VocabMap;
  ranks: MergeRanks;
  addedTokens: Map<string, number>;
  reverseAddedTokens: Map<number, string>;
}
