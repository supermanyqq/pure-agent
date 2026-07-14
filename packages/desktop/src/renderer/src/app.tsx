import { ChatView } from './components/chat-view.js';
import { Composer } from './components/composer.js';
import { Sidebar } from './components/sidebar.js';
import { useSessions } from './hooks/use-sessions.js';

export function App() {
  const {
    sessions,
    selectedSession,
    selectSession,
    createSession,
    sendMessage,
    stopSession,
  } = useSessions();

  return (
    <div className="desktop-shell">
      <Sidebar
        sessions={sessions}
        selectedSessionId={selectedSession?.id}
        onCreateSession={() => void createSession()}
        onSelectSession={selectSession}
      />
      <main className="main-workspace">
        <ChatView session={selectedSession} />
        <Composer
          disabled={!selectedSession}
          status={selectedSession?.status}
          onSend={sendMessage}
          onStop={stopSession}
        />
      </main>
    </div>
  );
}
