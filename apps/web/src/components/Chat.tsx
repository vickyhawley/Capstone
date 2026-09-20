import { useEffect, useRef, useState } from 'react';

import { ApiError, postAnswer } from '../api/client.js';
import styles from './Chat.module.css';
import { InputBar } from './InputBar.js';
import { MessageBubble, type Message } from './Message.js';

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `msg-${idCounter}`;
}

/**
 * Multi-turn chat area. History lives in component state; the API
 * is stateless (each POST /api/answer carries only the current
 * query). GW-16 conversation memory would move this state up into
 * a shared store and thread a conversation_id through the request.
 */
export function Chat() {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [pending, setPending] = useState(false);
  const scrollAnchor = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message. Runs on messages length change
  // rather than every render so it doesn't fight with the user's own
  // scroll if they've paged up. `scrollIntoView` is guarded because
  // jsdom (test environment) doesn't implement it.
  useEffect(() => {
    scrollAnchor.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  async function handleSubmit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    const userMsg: Message = { kind: 'user', id: nextId(), text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setPending(true);

    try {
      const response = await postAnswer(trimmed);
      setMessages((prev) => [...prev, { kind: 'bot', id: nextId(), response }]);
    } catch (err: unknown) {
      const errorText =
        err instanceof ApiError
          ? `Something went wrong on the server (${err.status}). Please try again.`
          : "Couldn't reach the assistant — check your connection and try again.";
      setMessages((prev) => [...prev, { kind: 'error', id: nextId(), message: errorText }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.chat}>
      <div className={styles.history} aria-live="polite" aria-label="Conversation">
        {messages.length === 0 ? (
          <div className={styles.emptyState}>
            <p>Ask about products, delivery, sizing, or ordering.</p>
            <p className={styles.emptyExamples}>
              <span>Try: </span>
              <button
                type="button"
                className={styles.exampleChip}
                onClick={() => void handleSubmit('Do you stock Haygates conditioning cubes?')}
              >
                Do you stock Haygates conditioning cubes?
              </button>
              <button
                type="button"
                className={styles.exampleChip}
                onClick={() => void handleSubmit('Do you deliver to BH24?')}
              >
                Do you deliver to BH24?
              </button>
            </p>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
        {pending ? (
          <div className={styles.pending} aria-label="Assistant is thinking">
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
          </div>
        ) : null}
        <div ref={scrollAnchor} />
      </div>
      <InputBar onSubmit={handleSubmit} disabled={pending} />
    </div>
  );
}
