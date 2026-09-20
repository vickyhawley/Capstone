import { Chat } from './components/Chat.js';
import { Header } from './components/Header.js';

/**
 * Groundwork web app. Sprint 4.
 *
 * Chat shell over the /api/answer surface. Multi-turn UI, stateless
 * API (GW-16 conversation memory is a Sprint 4+ story). The Chat
 * component owns the message history + submit flow; Header owns the
 * title + About-panel toggle.
 */
export function App() {
  return (
    <main className="app-shell">
      <Header />
      <Chat />
    </main>
  );
}
