import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initTokenizer, encode, countTokens, decode, isInitialized } from '../deepseek-tokenizer.js';
import type { TokenizerData } from '../types.js';

const TOKENIZER_PATH = join(__dirname, '..', 'tokenizer.json');

beforeAll(() => {
  if (!isInitialized()) {
    const raw = readFileSync(TOKENIZER_PATH, 'utf-8');
    const data = JSON.parse(raw) as TokenizerData;
    initTokenizer(data);
  }
});

describe('DeepSeek Tokenizer', () => {
  it('initializes correctly', () => {
    expect(isInitialized()).toBe(true);
  });

  it('encodes English text', () => {
    const ids = encode('Hello!');
    expect(ids.length).toBeGreaterThan(0);
    expect(Array.isArray(ids)).toBe(true);
  });

  it('encodes Chinese text', () => {
    const ids = encode('你好世界');
    expect(ids.length).toBeGreaterThan(0);
  });

  it('encodes mixed text', () => {
    const ids = encode('Hello, 你好!');
    expect(ids.length).toBeGreaterThan(0);
  });

  it('countTokens returns correct count', () => {
    const text = 'Hello, world!';
    expect(countTokens(text)).toBe(encode(text).length);
  });

  it('encode/decode round-trip', () => {
    const text = 'Hello world';
    const decoded = decode(encode(text));
    expect(decoded).toContain('Hello');
  });

  it('handles empty string', () => {
    expect(encode('')).toEqual([]);
    expect(countTokens('')).toBe(0);
  });

  it('encodes special tokens', () => {
    const ids = encode('<｜begin▁of▁sentence｜>');
    expect(ids.length).toBe(1);
  });

  it('encodes code text', () => {
    const ids = encode('function helloWorld() {\n  return "hello";\n}');
    expect(ids.length).toBeGreaterThan(0);
  });

  it('produces consistent results', () => {
    const text = 'The quick brown fox';
    expect(encode(text)).toEqual(encode(text));
  });
});
