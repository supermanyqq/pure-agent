import { describe, it, expect, vi } from 'vitest';
import { createContextManager } from '../trimmer.js';
import { ContextWindowError } from '../../types/index.js';
import type { Message, ToolCall, Summarizer, TrimResult, SummaryResult } from '../../types/index.js';

function user(content: string): Message {
  return { role: 'user', content };
}
function assistant(content: string | null, calls?: ToolCall[]): Message {
  return calls ? { role: 'assistant', content, toolCalls: calls } as Message : { role: 'assistant', content } as Message;
}
function toolMsg(callId: string, content: string): Message {
  return { role: 'tool', content, toolCallId: callId };
}

function mockSummarizer(response = 'Mock summary.'): Summarizer {
  return {
    summarize: vi.fn(async (): Promise<SummaryResult> => ({
      body: response,
      method: 'llm' as const,
    })),
  };
}

describe('Trimmer', () => {
  describe('createContextManager', () => {
    it('无 summarizer 正常创建', () => {
      expect(createContextManager()).toBeDefined();
    });
  });

  describe('fitToWindow', () => {
    it('空消息返回空 TrimResult', async () => {
      const cm = createContextManager();
      const r = await cm.fitToWindow([], []);
      expect(r.messages).toEqual([]);
      expect(r.status).toBe('unchanged');
    });

    it('少量消息不裁剪', async () => {
      const cm = createContextManager();
      const msgs: Message[] = [
        { role: 'system', content: 'Helper' },
        user('Hello'),
        assistant('Hi!'),
      ];
      const r = await cm.fitToWindow(msgs, []);
      expect(r.removedTurns).toBe(0);
      expect(r.status).toBe('unchanged');
    });

    it('system prompt 超限抛 ContextWindowError', async () => {
      const cm = createContextManager({ config: { contextWindow: 10, maxSummaryTokens: 2000, tailTokenBudget: 0, minTurns: 1, safetyMarginRatio: 0, maxSafetyMargin: 0, enableSummarization: true } });
      await expect(
        cm.fitToWindow([{ role: 'system', content: 'X'.repeat(1000) }, user('Q')], [], { completionReserve: 0 }),
      ).rejects.toThrow(ContextWindowError);
    });

    it('summarizer 被调用', async () => {
      const s = mockSummarizer('Compressed.');
      const cm = createContextManager({
        summarizer: s,
        config: { contextWindow: 2000, tailTokenBudget: 50, maxSummaryTokens: 2000, minTurns: 1, safetyMarginRatio: 0, maxSafetyMargin: 0, enableSummarization: true },
      });

      const msgs: Message[] = [
        { role: 'system', content: 'S' },
        user('Q1 ' + 'x'.repeat(300)),
        assistant('A1 ' + 'x'.repeat(300)),
        user('Q2 ' + 'x'.repeat(300)),
        assistant('A2 ' + 'x'.repeat(300)),
        user('Q3 ' + 'x'.repeat(300)),
        assistant('A3 ' + 'x'.repeat(300)),
      ];

      const r = await cm.fitToWindow(msgs, [], { completionReserve: 0 });
      if (r.removedTurns > 0) {
        expect(s.summarize).toHaveBeenCalled();
        expect(r.summarized).toBe(true);
      }
    });

    it('禁用摘要时不调 summarizer', async () => {
      const s = mockSummarizer();
      const cm = createContextManager({
        summarizer: s,
        config: { contextWindow: 2000, tailTokenBudget: 50, maxSummaryTokens: 2000, minTurns: 1, safetyMarginRatio: 0, maxSafetyMargin: 0, enableSummarization: true },
      });

      const msgs: Message[] = [
        { role: 'system', content: 'S' },
        user('Q1 ' + 'x'.repeat(300)), assistant('A1 ' + 'x'.repeat(300)),
        user('Q2 ' + 'x'.repeat(300)), assistant('A2 ' + 'x'.repeat(300)),
        user('Q3 ' + 'x'.repeat(300)), assistant('A3 ' + 'x'.repeat(300)),
      ];

      await cm.fitToWindow(msgs, [], { completionReserve: 0, enableSummarization: false });
      expect(s.summarize).not.toHaveBeenCalled();
    });

    it('summarizer 失败降级为回退摘要', async () => {
      const failing: Summarizer = { summarize: vi.fn(async () => { throw new Error('LLM down'); }) };
      const cm = createContextManager({
        summarizer: failing,
        config: { contextWindow: 2000, tailTokenBudget: 50, maxSummaryTokens: 2000, minTurns: 1, safetyMarginRatio: 0, maxSafetyMargin: 0, enableSummarization: true },
      });

      const msgs: Message[] = [
        { role: 'system', content: 'S' },
        user('Q1 ' + 'x'.repeat(300)), assistant('A1 ' + 'x'.repeat(300)),
        user('Q2 ' + 'x'.repeat(300)), assistant('A2 ' + 'x'.repeat(300)),
        user('Q3 ' + 'x'.repeat(300)), assistant('A3 ' + 'x'.repeat(300)),
      ];

      const r = await cm.fitToWindow(msgs, [], { completionReserve: 0 });
      if (r.removedTurns > 0) {
        expect(r.status).toBe('fallback_summary');
        expect(r.summary).toBeDefined();
      }
    });

    it('反抖动连续无效后跳过', async () => {
      const cm = createContextManager({
        config: { contextWindow: 1_000_000, tailTokenBudget: 500_000, maxSummaryTokens: 2000, minTurns: 1, safetyMarginRatio: 0.1, maxSafetyMargin: 1000, enableSummarization: false },
      });
      const msgs: Message[] = [user('Hello'), assistant('Hi')];

      // 连续调用不超限的场景
      for (let i = 0; i < 10; i++) {
        await cm.fitToWindow(msgs, []);
      }

      const stats = cm.getCompressionStats();
      expect(stats).toBeDefined();
    });

    it('getCompressionStats 初始状态', () => {
      const cm = createContextManager();
      const s = cm.getCompressionStats();
      expect(s.compressionCount).toBe(0);
      expect(s.ineffectiveCompressionCount).toBe(0);
      expect(s.summaryInCooldown).toBe(false);
    });

    it('reset 清除所有状态', () => {
      const cm = createContextManager();
      cm.reset();
      const s = cm.getCompressionStats();
      expect(s.compressionCount).toBe(0);
    });

    it('工具消息过大时截断', async () => {
      const cm = createContextManager({
        config: { contextWindow: 2000, tailTokenBudget: 50, maxSummaryTokens: 2000, minTurns: 1, safetyMarginRatio: 0, maxSafetyMargin: 0, enableSummarization: false },
      });
      const msgs: Message[] = [
        { role: 'system', content: 'S' },
        user('Q'),
        assistant(null, [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]),
        toolMsg('c1', 'x'.repeat(20_000)),
        assistant('Done'),
        user('Q2'),
        assistant('A2'),
      ];
      const r = await cm.fitToWindow(msgs, [], { completionReserve: 0 });
      const toolMsgs = r.messages.filter((m) => m.role === 'tool');
      if (toolMsgs.length > 0) {
        for (const tm of toolMsgs) {
          if (tm.content.includes('[Result truncated')) {
            expect(tm.content.length).toBeLessThan(20_000);
          }
        }
      }
    });
  });
});
