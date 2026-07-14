import type { SessionSnapshot } from '../../../shared/ipc.js';

const NEW_SESSION_LABEL = '新建会话';
const SIDEBAR_HEADING = '会话历史';
const EMPTY_HISTORY_LABEL = '还没有历史会话';

interface SidebarProps {
  sessions: SessionSnapshot[];
  selectedSessionId: string | undefined;
  onCreateSession(): void;
  onSelectSession(sessionId: string): void;
}

/** Provides session history navigation without adding a second content panel. */
export function Sidebar({
  sessions,
  selectedSessionId,
  onCreateSession,
  onSelectSession,
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label={SIDEBAR_HEADING}>
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">✦</span>
        <span>Pure Agent</span>
      </div>
      <button className="new-session-button" type="button" onClick={onCreateSession}>
        <span aria-hidden="true">＋</span>
        {NEW_SESSION_LABEL}
      </button>
      <div className="history-heading">{SIDEBAR_HEADING}</div>
      <nav className="session-list" aria-label={SIDEBAR_HEADING}>
        {sessions.length === 0 && <p className="empty-history">{EMPTY_HISTORY_LABEL}</p>}
        {sessions.map((session) => {
          const isSelected = session.id === selectedSessionId;
          return (
            <button
              className={`session-item${isSelected ? ' session-item-selected' : ''}`}
              key={session.id}
              type="button"
              aria-current={isSelected ? 'page' : undefined}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="session-signal" aria-hidden="true" />
              <span className="session-item-copy">
                <span className="session-title">{session.title}</span>
                <span className="session-meta">{getSessionMeta(session)}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <p className="sidebar-footnote">当前设备 · 本地会话</p>
    </aside>
  );
}

function getSessionMeta(session: SessionSnapshot): string {
  if (session.status === 'thinking') return '正在思考';
  if (session.status === 'streaming') return '正在生成';
  if (session.status === 'error') return '需要处理';
  return `${session.messages.length} 条消息`;
}
