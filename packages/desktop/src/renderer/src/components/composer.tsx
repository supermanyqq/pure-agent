import { useState, type KeyboardEvent } from 'react';
import type { SessionStatus } from '../../../shared/ipc.js';

const ENTER_KEY = 'Enter';
const EMPTY_VALUE = '';
const SEND_LABEL = '发送';
const STOP_LABEL = '停止';
const PLACEHOLDER = '输入消息，Enter 发送，Shift + Enter 换行';

interface ComposerProps {
  status: SessionStatus | undefined;
  disabled: boolean;
  onSend(content: string): Promise<void>;
  onStop(): Promise<void>;
}

export function Composer({ status, disabled, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState(EMPTY_VALUE);
  const isGenerating = status === 'thinking' || status === 'streaming';
  const canSend = !disabled && !isGenerating && value.trim().length > 0;

  async function submit(): Promise<void> {
    if (!canSend) return;
    await onSend(value.trim());
    setValue(EMPTY_VALUE);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== ENTER_KEY || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  return (
    <div className="composer-shell">
      <textarea
        aria-label="输入消息"
        className="composer-input"
        disabled={disabled || isGenerating}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={PLACEHOLDER}
        rows={2}
        value={value}
      />
      <div className="composer-actions">
        <span className="composer-hint">Pure Agent 会保留本次会话上下文</span>
        {isGenerating ? (
          <button className="stop-button" type="button" onClick={() => void onStop()}>
            {STOP_LABEL}
          </button>
        ) : (
          <button className="send-button" disabled={!canSend} type="button" onClick={() => void submit()}>
            {SEND_LABEL}
          </button>
        )}
      </div>
    </div>
  );
}
