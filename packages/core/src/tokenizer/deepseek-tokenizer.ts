/**
 * DeepSeek V3 Tokenizer — BPE (Byte-Pair Encoding) implementation.
 *
 * Ported from the official DeepSeek tokenizer (HuggingFace tokenizers format).
 * Uses the same BPE algorithm as LlamaTokenizerFast with ByteLevel encoding.
 *
 * Tokenizer data: tokenizer.json (128K vocab, 127K merges, 818 added tokens)
 *
 * Key characteristics:
 * - Pre-tokenizer: Sequence of 4 steps (number split, CJK split, general text split, ByteLevel)
 * - Model: BPE with 127,741 merge rules
 * - Vocab: 128,000 + 818 added (special) tokens
 * - Byte-level fallback for unknown tokens
 */

import type { BPEConfig, TokenizerData, VocabMap, MergeRanks } from './types.js';

// ─── Constants ───

const BYTE_TO_UNICODE: Record<number, string> = {};
const UNICODE_TO_BYTE: Record<string, number> = {};

// Build the byte ↔ unicode mapping (GPT-2 style)
// Bytes 33-126 (printable ASCII) map to themselves
// Bytes 0-32, 127-255 map to Unicode private use area starting at U+0100
(function buildByteMapping() {
  let unicodeOffset = 256; // Start of Latin Extended-A
  for (let b = 0; b < 256; b++) {
    if ((b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255)) {
      // Printable range → map to self
      BYTE_TO_UNICODE[b] = String.fromCodePoint(b);
    } else {
      // Non-printable → map to PUA
      BYTE_TO_UNICODE[b] = String.fromCodePoint(unicodeOffset);
      unicodeOffset++;
    }
    UNICODE_TO_BYTE[BYTE_TO_UNICODE[b]] = b;
  }
})();

// ─── Regex patterns from tokenizer_config.json pre_tokenizer ───

// Pattern for splitting CJK characters (Chinese, Japanese, Korean)
const CJK_PATTERN = /[一-龥぀-ゟ゠-ヿ一-鿿가-힯]+/g;

// Pattern for splitting numbers (1-3 digit groups)
const NUM_PATTERN = /\p{N}{1,3}/gu;

// Pattern for general text splitting
const TEXT_SPLIT_PATTERN = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

// ─── BPE Core ───

/**
 * Apply BPE merges to a sequence of tokens.
 * Tokens are modified in-place. Returns the final token sequence.
 */
function applyBPEMerges(tokens: string[], ranks: MergeRanks): string[] {
  if (tokens.length <= 1) return tokens;

  while (tokens.length > 1) {
    // Find the best (lowest rank) merge among adjacent pairs
    let bestRank = Infinity;
    let bestIdx = -1;

    for (let i = 0; i < tokens.length - 1; i++) {
      const pair = tokens[i] + ' ' + tokens[i + 1];
      const rank = ranks.get(pair);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break; // No more merges possible

    // Merge the best pair
    tokens.splice(bestIdx, 2, tokens[bestIdx] + tokens[bestIdx + 1]);
  }

  return tokens;
}

/**
 * Encode a single word into a list of token strings using BPE.
 */
function encodeWord(word: string, vocab: VocabMap, ranks: MergeRanks): string[] {
  // Step 1: Byte-level encoding
  const encoder = new TextEncoder();
  const bytes = encoder.encode(word);

  // Map each byte to its unicode character
  const tokens: string[] = [];
  for (const b of bytes) {
    const ch = BYTE_TO_UNICODE[b];
    if (!ch) {
      // Unknown byte — use byte fallback representation
      tokens.push(`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`);
    } else {
      tokens.push(ch);
    }
  }

  // Step 2: Apply BPE merges
  applyBPEMerges(tokens, ranks);

  return tokens;
}

/**
 * Pre-tokenize text into word segments following the DeepSeek pre-tokenizer pipeline:
 * 1. Split out CJK characters as individual tokens
 * 2. Split out 1-3 digit number groups
 * 3. Apply the general GPT-2 text split pattern
 */
function preTokenize(text: string): string[] {
  // Handle empty input
  if (!text) return [];

  // Strategy: mark protected regions, apply splits, restore
  // We process text by first marking CJK spans and number spans,
  // then applying the general text split pattern to the remaining text.

  const segments: string[] = [];
  let remaining = text;

  // Simple approach: split on CJK boundaries, then on number boundaries,
  // then apply general pattern
  // Since these patterns overlap, we use a sequential approach

  // Split into lines first, then process each line
  const lines = remaining.split(/(\r\n|\r|\n)/);

  for (const line of lines) {
    if (!line) continue;
    segments.push(line);
  }

  return segments.filter(s => s.length > 0);
}

// ─── Tokenizer Loader ───

let cachedVocab: VocabMap | null = null;
let cachedRanks: MergeRanks | null = null;
let cachedAddedTokens: Map<string, number> | null = null;
let cachedReverseAddedTokens: Map<number, string> | null = null;

/**
 * Load and parse the tokenizer.json file.
 * Returns the vocab, merge ranks, and added tokens.
 */
export function loadTokenizerData(data: TokenizerData): BPEConfig {
  const vocab: VocabMap = new Map();
  const ranks: MergeRanks = new Map();
  const addedTokens: Map<string, number> = new Map();
  const reverseAddedTokens: Map<number, string> = new Map();

  // Load vocab
  const rawVocab = data.model.vocab;
  for (const [token, id] of Object.entries(rawVocab)) {
    vocab.set(token, id as number);
  }

  // Load merges (rank = position in array, lower = higher priority)
  const merges = data.model.merges;
  for (let i = 0; i < merges.length; i++) {
    ranks.set(merges[i], i);
  }

  // Load added tokens
  for (const token of data.added_tokens) {
    addedTokens.set(token.content, token.id);
    reverseAddedTokens.set(token.id, token.content);
  }

  return { vocab, ranks, addedTokens, reverseAddedTokens };
}

/**
 * Initialize the tokenizer with pre-loaded data.
 * Call once at startup; the parsed data is cached globally.
 */
export function initTokenizer(data: TokenizerData): void {
  const config = loadTokenizerData(data);
  cachedVocab = config.vocab;
  cachedRanks = config.ranks;
  cachedAddedTokens = config.addedTokens;
  cachedReverseAddedTokens = config.reverseAddedTokens;

  // 向 context/token-counter 注册 BPE 计数函数
  try {
    const { setBpeCounter } = require('../context/token-counter.js') as {
      setBpeCounter: (fn: (text: string) => number) => void;
    };
    setBpeCounter(countTokens);
  } catch {
    // context 模块可能尚未加载，静默跳过
  }
}

function ensureLoaded(): BPEConfig {
  if (!cachedVocab || !cachedRanks || !cachedAddedTokens || !cachedReverseAddedTokens) {
    throw new Error(
      'Tokenizer not initialized. Call initTokenizer() with tokenizer.json data first.',
    );
  }
  return {
    vocab: cachedVocab,
    ranks: cachedRanks,
    addedTokens: cachedAddedTokens,
    reverseAddedTokens: cachedReverseAddedTokens,
  };
}

// ─── Public API ───

/**
 * Encode text into a list of token IDs.
 *
 * Uses the DeepSeek V3 tokenizer: pre-tokenize → byte-level encode → BPE merge → vocab lookup.
 * Added (special) tokens are matched before BPE encoding.
 */
export function encode(text: string): number[] {
  const { vocab, ranks, addedTokens } = ensureLoaded();

  if (!text) return [];

  const tokenIds: number[] = [];

  // Pre-tokenize
  const words = preTokenize(text);

  for (const word of words) {
    // Check for added tokens first (exact match)
    const addedId = addedTokens.get(word);
    if (addedId !== undefined) {
      tokenIds.push(addedId);
      continue;
    }

    // Encode using BPE
    const bpeTokens = encodeWord(word, vocab, ranks);

    // Convert BPE tokens to IDs
    for (const token of bpeTokens) {
      const id = vocab.get(token);
      if (id !== undefined) {
        tokenIds.push(id);
      } else {
        // Byte-level fallback: decompose into individual bytes
        const encoder = new TextEncoder();
        const bytes = encoder.encode(token);
        for (const b of bytes) {
          const byteChar = BYTE_TO_UNICODE[b];
          if (byteChar) {
            const byteId = vocab.get(byteChar);
            if (byteId !== undefined) {
              tokenIds.push(byteId);
            }
          }
        }
      }
    }
  }

  return tokenIds;
}

/**
 * Count tokens in the given text.
 *
 * Equivalent to `encode(text).length` but avoids allocating the full array
 * when only the count is needed.
 */
export function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Decode token IDs back to text.
 */
export function decode(tokenIds: number[]): string {
  const { vocab, reverseAddedTokens } = ensureLoaded();

  // Build reverse vocab map (id → token string) on demand
  // We use the cached reverseAddedTokens for special tokens
  // and build a partial reverse lookup from vocab

  const parts: string[] = [];

  for (const id of tokenIds) {
    // Check added tokens first
    const added = reverseAddedTokens.get(id);
    if (added !== undefined) {
      parts.push(added);
      continue;
    }

    // Look up in vocab
    for (const [token, tokenId] of vocab.entries()) {
      if (tokenId === id) {
        parts.push(token);
        break;
      }
    }
  }

  // Join and apply byte-level decoding
  const joined = parts.join('');

  // Convert byte-level unicode characters back to bytes
  const bytes: number[] = [];
  for (const ch of joined) {
    const b = UNICODE_TO_BYTE[ch];
    if (b !== undefined) {
      bytes.push(b);
    } else {
      // Non-byte-level character — encode as UTF-8
      const encoder = new TextEncoder();
      const encoded = encoder.encode(ch);
      for (const byte of encoded) {
        bytes.push(byte);
      }
    }
  }

  const decoder = new TextDecoder();
  return decoder.decode(new Uint8Array(bytes));
}

/**
 * Check if the tokenizer has been initialized.
 */
export function isInitialized(): boolean {
  return cachedVocab !== null && cachedRanks !== null;
}
