import { describe, it, expect } from 'vitest';
import {
  SUMMARY_PREFIX, SUMMARY_END_MARKER,
  formatSummary, stripSummaryPrefix, isContextSummaryContent,
  buildSummaryPrompt, serializeForSummary, computeSummaryBudget,
  buildFallbackSummary,
} from '../summarizer.js';
import { redactSensitiveText } from '../redactor.js';
import type { Message } from '../../types/index.js';

describe('Summarizer', () => {
  describe('SUMMARY_PREFIX', () => {
    it('含反注入关键措辞', () => {
      expect(SUMMARY_PREFIX).toContain('REFERENCE ONLY');
      expect(SUMMARY_PREFIX).toContain('NOT as active instructions');
    });
  });

  describe('formatSummary / stripSummaryPrefix', () => {
    it('round-trip 正确', () => {
      const body = 'Test summary body';
      const wrapped = formatSummary(body);
      expect(wrapped).toContain(SUMMARY_PREFIX);
      expect(wrapped).toContain(SUMMARY_END_MARKER);
      expect(stripSummaryPrefix(wrapped)).toBe(body);
    });
  });

  describe('isContextSummaryContent', () => {
    it('识别摘要', () => {
      expect(isContextSummaryContent(formatSummary('test'))).toBe(true);
    });
    it('普通文本返回 false', () => {
      expect(isContextSummaryContent('Hello')).toBe(false);
    });
  });

  describe('serializeForSummary', () => {
    it('序列化为标注文本', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];
      const s = serializeForSummary(msgs);
      expect(s).toContain('[USER]');
      expect(s).toContain('[ASSISTANT]');
    });

    it('自动脱敏', () => {
      const msgs: Message[] = [
        { role: 'tool', content: 'API_KEY=sk-abc123def456ghi789jkl012mno345pqr678stu', toolCallId: 'c1' },
      ];
      const s = serializeForSummary(msgs);
      expect(s).not.toContain('sk-abc123');
    });
  });

  describe('buildSummaryPrompt', () => {
    it('首次压缩含模板结构', () => {
      const p = buildSummaryPrompt({ contentToSummarize: '[USER]: Hello', summaryBudget: 2000 });
      expect(p).toContain('Historical Task Snapshot');
      expect(p).toContain('Goal');
    });

    it('迭代更新含 PREVIOUS SUMMARY', () => {
      const p = buildSummaryPrompt({ contentToSummarize: '[USER]: New', summaryBudget: 2000, previousSummary: 'Old summary' });
      expect(p).toContain('PREVIOUS SUMMARY');
    });
  });

  describe('computeSummaryBudget', () => {
    it('不低于 min', () => {
      expect(computeSummaryBudget(5_000, 12_000)).toBe(2_000);
    });
    it('不超过 max', () => {
      expect(computeSummaryBudget(100_000, 5_000)).toBeLessThanOrEqual(5_000);
    });
  });

  describe('buildFallbackSummary', () => {
    it('生成有效回退摘要', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Read config' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"config.json"}' } }] },
        { role: 'tool', content: '{"port":3000}', toolCallId: 'c1' },
        { role: 'assistant', content: 'Config shows port 3000.' },
      ];
      const fb = buildFallbackSummary(msgs);
      expect(fb).toContain(SUMMARY_PREFIX);
      expect(fb).toContain('Historical Task Snapshot');
    });

    it('脱敏 API key', () => {
      const fb = buildFallbackSummary([
        { role: 'user', content: 'Key is sk-abc123def456ghi789jkl012mno345pqr678stu' },
      ]);
      expect(fb).not.toContain('sk-abc123');
    });
  });
});
