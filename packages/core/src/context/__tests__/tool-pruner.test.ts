import { describe, it, expect } from 'vitest';
import { pruneOldToolResults } from '../tool-pruner.js';
import type { Message } from '../../types/index.js';

function user(content: string): Message {
  return { role: 'user', content };
}
function assistantWithCall(id: string, name: string, args = '{}'): Message {
  return { role: 'assistant', content: null, toolCalls: [{ id, type: 'function', function: { name, arguments: args } }] };
}
function toolMsg(callId: string, content: string): Message {
  return { role: 'tool', content, toolCallId: callId };
}

describe('ToolPruner', () => {
  it('小结果不裁剪', () => {
    const msgs = [user('read'), assistantWithCall('c1', 'read_file'), toolMsg('c1', 'short')];
    const r = pruneOldToolResults(msgs, { protectTailCount: 8 });
    expect(r.prunedCount).toBe(0);
  });

  it('大结果替换为摘要', () => {
    const msgs = [user('read'), assistantWithCall('c1', 'read_file', '{"path":"a.txt"}'), toolMsg('c1', 'x'.repeat(300))];
    const r = pruneOldToolResults(msgs, { protectTailCount: 0 });
    expect(r.messages[2].content).toContain('[read_file]');
    expect(r.prunedCount).toBeGreaterThanOrEqual(1);
  });

  it('去重相同内容', () => {
    const dup = 'x'.repeat(300);
    const msgs = [
      user('read x2'),
      assistantWithCall('c1', 'read_file', '{"path":"a.txt"}'), toolMsg('c1', dup),
      assistantWithCall('c2', 'read_file', '{"path":"a.txt"}'), toolMsg('c2', dup),
    ];
    const r = pruneOldToolResults(msgs, { protectTailCount: 8 });
    expect(r.messages[2].content).toContain('Duplicate');
  });

  it('尾部受保护不裁剪', () => {
    const c1 = 'a'.repeat(300);
    const c2 = 'b'.repeat(300);
    const msgs = [
      user('read 2'),
      assistantWithCall('c1', 'read_file'), toolMsg('c1', c1),
      assistantWithCall('c2', 'read_file'), toolMsg('c2', c2),
    ];
    // 保护尾部 3 条消息（c2 的 assistant + tool + ?）→ c2 tool 结果不被裁剪
    const r = pruneOldToolResults(msgs, { protectTailCount: 3 });
    expect(r.messages[4].content).toBe(c2);
  });

  it('terminal 命令结果摘要正确', () => {
    const content = '{"exit_code": 0, "output": "' + 'x'.repeat(300) + '"}';
    const msgs = [
      user('run test'),
      assistantWithCall('c1', 'terminal', '{"command":"npm test"}'),
      toolMsg('c1', content),
    ];
    const r = pruneOldToolResults(msgs, { protectTailCount: 0 });
    expect(r.messages[2].content).toContain('[terminal]');
    expect(r.messages[2].content).toContain('npm test');
    expect(r.messages[2].content).toContain('exit 0');
  });
});
