import { describe, it, expect } from 'vitest';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolDefinitions,
  estimateTotal,
  estimateMsgBudgetTokens,
} from '../token-counter.js';
import type { Message, ToolDefinition } from '../../types/index.js';

describe('TokenCounter', () => {
  describe('estimateMessageTokens', () => {
    it('空内容至少有基础开销', () => {
      expect(estimateMessageTokens({ role: 'user', content: '' })).toBeGreaterThanOrEqual(1);
    });

    it('英文估算合理', () => {
      const t = estimateMessageTokens({ role: 'user', content: 'Hello, how are you?' });
      expect(t).toBeGreaterThanOrEqual(4);
      expect(t).toBeLessThanOrEqual(25);
    });

    it('中文估算合理', () => {
      const t = estimateMessageTokens({ role: 'user', content: '你好，请帮我分析这个项目' });
      expect(t).toBeGreaterThanOrEqual(5);
    });

    it('含 tool_calls 的 assistant 消息估算更高', () => {
      const withCalls: Message = {
        role: 'assistant', content: 'Let me check.',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' } }],
      };
      const withoutCalls: Message = { role: 'assistant', content: 'Let me check.' };
      expect(estimateMessageTokens(withCalls)).toBeGreaterThan(estimateMessageTokens(withoutCalls));
    });
  });

  describe('estimateMessagesTokens', () => {
    it('空数组返回0', () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    it('累加正确', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];
      expect(estimateMessagesTokens(msgs)).toBeGreaterThan(0);
    });
  });

  describe('estimateToolDefinitions', () => {
    it('空数组返回0', () => {
      expect(estimateToolDefinitions([])).toBe(0);
    });

    it('单工具返回正数', () => {
      const t: ToolDefinition[] = [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }];
      expect(estimateToolDefinitions(t)).toBeGreaterThan(0);
    });
  });

  describe('estimateTotal', () => {
    it('含安全余量', () => {
      const r = estimateTotal([{ role: 'user', content: 'Hello' }], []);
      expect(r.messageTokens).toBeGreaterThan(0);
      expect(r.safetyMargin).toBeGreaterThan(0);
      expect(r.total).toBe(r.messageTokens + r.toolTokens + r.safetyMargin);
    });

    it('安全余量不超过上限', () => {
      const r = estimateTotal([{ role: 'user', content: 'x'.repeat(100_000) }], [], { maxSafetyMargin: 1000 });
      expect(r.safetyMargin).toBeLessThanOrEqual(1000);
    });
  });

  describe('estimateMsgBudgetTokens', () => {
    it('与详细估算数量级一致', () => {
      const msg: Message = { role: 'user', content: 'Hello, test message.' };
      const detailed = estimateMessageTokens(msg);
      const budget = estimateMsgBudgetTokens(msg);
      expect(Math.abs(detailed - budget)).toBeLessThan(20);
    });
  });
});
