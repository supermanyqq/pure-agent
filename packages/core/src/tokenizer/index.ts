/**
 * DeepSeek V3 Tokenizer — module entry point.
 *
 * Usage:
 * ```typescript
 * import { initTokenizer, loadTokenizerFromFile, countTokens, encode } from '@pure-agent/core/tokenizer';
 *
 * // Load at startup
 * const data = JSON.parse(fs.readFileSync('tokenizer.json', 'utf-8'));
 * initTokenizer(data);
 *
 * // Or use the convenience loader
 * await loadTokenizerFromFile('./tokenizer.json');
 *
 * // Count tokens
 * const n = countTokens('Hello, world!');
 * ```
 */

export { initTokenizer, encode, countTokens, decode, isInitialized, loadTokenizerData } from './deepseek-tokenizer.js';
export type { TokenizerData, VocabMap, MergeRanks, BPEConfig } from './types.js';

import { readFileSync } from 'node:fs';
import { initTokenizer } from './deepseek-tokenizer.js';
import type { TokenizerData } from './types.js';

/**
 * Convenience function: load tokenizer.json from a file path and initialize.
 * Synchronous for simplicity — the file is ~7.8MB and should be loaded at startup.
 */
export function loadTokenizerFromFile(filePath: string): void {
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as TokenizerData;
  initTokenizer(data);
}
