import { describe, it, expect } from 'vitest';
import {
  groupByTurns, getTurnCount, removeOldestTurns,
  getSystemTurn, hasSystemPrompt,
  alignBoundaryForward, alignBoundaryBackward,
  findLastUserMessageIdx, findLastAssistantMessageIdx, findTurnPairEnd,
} from '../history-manager.js';
import type { Message } from '../../types/index.js';

describe('HistoryManager', () => {
  describe('groupByTurns', () => {
    it('空消息返回空', () => {
      expect(groupByTurns([])).toEqual([]);
    });

    it('system prompt 为 Turn 0', () => {
      const turns = groupByTurns([
        { role: 'system', content: 'S' },
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: 'A' },
      ]);
      expect(turns[0].index).toBe(0);
      expect(turns[1].index).toBe(1);
    });

    it('无 system 时 Turn 从 1 开始', () => {
      const turns = groupByTurns([
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: 'A' },
      ]);
      expect(turns[0].index).toBe(1);
    });

    it('单轮多工具调用属同一 Turn', () => {
      const turns = groupByTurns([
        { role: 'user', content: 'Read files' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'result', toolCallId: 'c1' },
        { role: 'assistant', content: 'Done.' },
      ]);
      expect(turns).toHaveLength(1);
    });

    it('多轮对话正确分组', () => {
      const turns = groupByTurns([
        { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' },
        { role: 'user', content: 'Q3' }, { role: 'assistant', content: 'A3' },
      ]);
      expect(turns).toHaveLength(3);
    });
  });

  describe('getTurnCount', () => {
    it('不包括 system Turn', () => {
      expect(getTurnCount([
        { role: 'system', content: 'S' },
        { role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' },
      ])).toBe(1);
    });
  });

  describe('removeOldestTurns', () => {
    it('保留 system Turn', () => {
      const { kept } = removeOldestTurns([
        { role: 'system', content: 'S' },
        { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' },
      ], 1);
      expect(kept[0]).toEqual({ role: 'system', content: 'S' });
      expect(kept).toHaveLength(3);
    });
  });

  describe('getSystemTurn', () => {
    it('有 system 时返回 Turn 0', () => {
      expect(getSystemTurn([{ role: 'system', content: 'S' }])?.index).toBe(0);
    });
    it('无 system 时返回 null', () => {
      expect(getSystemTurn([{ role: 'user', content: 'Q' }])).toBeNull();
    });
  });

  describe('hasSystemPrompt', () => {
    it('正确判断', () => {
      expect(hasSystemPrompt([{ role: 'system', content: 'S' }])).toBe(true);
      expect(hasSystemPrompt([{ role: 'user', content: 'Q' }])).toBe(false);
    });
  });

  describe('alignBoundaryForward', () => {
    it('跳过 tool 消息', () => {
      const msgs: Message[] = [
        { role: 'tool', content: 'r', toolCallId: 'c1' },
        { role: 'user', content: 'Q' },
      ];
      expect(alignBoundaryForward(msgs, 0)).toBe(1);
    });
  });

  describe('alignBoundaryBackward', () => {
    it('tool 组前有 assistant 时回到 assistant', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', content: 'r', toolCallId: 'c1' },
        { role: 'user', content: 'NextQ' },
      ];
      // 切割点在 index=2（tool 之后）→ 应对齐到 index=1（assistant 前）
      expect(alignBoundaryBackward(msgs, 2)).toBe(1);
    });
  });

  describe('findLastUserMessageIdx', () => {
    it('找到最后 user', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' },
      ];
      expect(findLastUserMessageIdx(msgs, 0)).toBe(2);
    });
  });

  describe('findLastAssistantMessageIdx', () => {
    it('找有文本的 assistant', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', content: 'r', toolCallId: 'c1' },
        { role: 'assistant', content: 'Final answer' },
      ];
      expect(findLastAssistantMessageIdx(msgs, 0)).toBe(3);
    });
  });

  describe('findTurnPairEnd', () => {
    it('返回完整 turn-pair 结束位置', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', content: 'r', toolCallId: 'c1' },
        { role: 'tool', content: 'r2', toolCallId: 'c2' },
        { role: 'user', content: 'NextQ' },
      ];
      expect(findTurnPairEnd(msgs, 0)).toBe(4);
    });
  });
});
