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

// Empty-state suggestions, grouped by category. Teaches the shape
// of the assistant in one glance. Content is drawn from the demo's
// known-good paths (products with matching chunks, real postcodes,
// real shop-info queries) so first-clicks always succeed.
const EXAMPLE_CATEGORIES: readonly {
  readonly label: string;
  readonly queries: readonly string[];
}[] = [
  {
    label: 'Products',
    queries: [
      'Do you stock Haygates conditioning cubes?',
      'Do you sell hemp bedding?',
    ],
  },
  {
    label: 'Delivery',
    queries: ['Do you deliver to BH24?', 'How much is delivery?'],
  },
  {
    label: 'Contact & hours',
    queries: ['What is your phone number?', 'When are you open on Sunday?'],
  },
];

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
      setMessages((prev) => [
        ...prev,
        // Attach the failed query so the retry button can re-submit
        // without the customer re-typing.
        { kind: 'error', id: nextId(), message: errorText, failedQuery: trimmed },
      ]);
    } finally {
      setPending(false);
    }
  }

  // Retry: re-submit the failed query. We don't remove the error
  // bubble — the customer sees both the previous failure and the
  // new attempt, which is honest.
  function handleRetry(query: string): void {
    void handleSubmit(query);
  }

  return (
    <div className={styles.chat}>
      <div className={styles.history} aria-live="polite" aria-label="Conversation">
        {messages.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyHeadline}>What can I help you find?</p>
            <p className={styles.emptySub}>
              Products, delivery, sizing, opening hours, ordering — try one of these to start.
            </p>
            <div className={styles.exampleCategories}>
              {EXAMPLE_CATEGORIES.map((cat) => (
                <div key={cat.label} className={styles.exampleCategory}>
                  <div className={styles.exampleLabel}>{cat.label}</div>
                  <div className={styles.exampleChipRow}>
                    {cat.queries.map((q) => (
                      <button
                        key={q}
                        type="button"
                        className={styles.exampleChip}
                        onClick={() => void handleSubmit(q)}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} onRetry={handleRetry} />
          ))
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
