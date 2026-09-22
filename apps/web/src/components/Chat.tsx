import { useEffect, useRef, useState } from 'react';

import { ApiError, streamAnswer } from '../api/client.js';
import type { AnswerResponse } from '../api/types.js';
import styles from './Chat.module.css';
import { InputBar } from './InputBar.js';
import { MessageBubble, type Message, type StreamingStep } from './Message.js';

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
 * Multi-turn chat area. Local component state renders the history;
 * the API layer (GW-16, ADR-0017) owns the authoritative conversation
 * store — the client mirrors it for UI purposes and quotes the
 * server-issued `conversation_id` on each subsequent request.
 */
export function Chat() {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [pending, setPending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const scrollAnchor = useRef<HTMLDivElement>(null);

  function handleNewConversation(): void {
    if (pending) return;
    setMessages([]);
    setConversationId(null);
  }

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

    // Insert a placeholder bot bubble that we'll grow as deltas
    // arrive. The bubble is created BEFORE the network call so
    // the customer sees the empty bubble + spinner immediately.
    const botId = nextId();
    const placeholder: AnswerResponse = {
      answer: '',
      citations: [],
      retrieved_chunk_ids: [],
      refusal_reason: null,
      trace_id: null,
      intent: null,
      adversarial_suspected: false,
      adversarial_pattern: null,
      product_query: null,
      behavior: 'answer',
      escalation_target: null,
      tool_calls: [],
      substitute_handles: [],
      delivery_zone_status: null,
      product_links: [],
      conversation_id: null,
      rewritten_query: null,
    };
    setMessages((prev) => [...prev, { kind: 'bot', id: botId, response: placeholder }]);

    // Accumulate the answer text + streaming steps in locals so we
    // can update without racing setState. Each event triggers one
    // setState call; final done event replaces the response with
    // the full metadata.
    let accumulated = '';
    const steps: StreamingStep[] = [];
    const patchBot = (patch: {
      readonly response?: Partial<AnswerResponse>;
      readonly steps?: readonly StreamingStep[];
    }): void => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.kind !== 'bot' || m.id !== botId) return m;
          return {
            ...m,
            ...(patch.response ? { response: { ...m.response, ...patch.response } } : {}),
            ...(patch.steps !== undefined ? { steps: patch.steps } : {}),
          };
        }),
      );
    };

    try {
      await streamAnswer(
        trimmed,
        {
          onToolStart: ({ name }) => {
            steps.push({ name, done: false });
            patchBot({ steps: [...steps] });
          },
          onToolComplete: ({ name, ok }) => {
            // Match by name — no request-id yet, tools don't fire
            // twice in one turn. Update the LAST matching step.
            for (let i = steps.length - 1; i >= 0; i -= 1) {
              const step = steps[i];
              if (step && step.name === name && !step.done) {
                steps[i] = { name, done: true, ok };
                break;
              }
            }
            patchBot({ steps: [...steps] });
          },
          onAnswerDelta: ({ text: delta }) => {
            accumulated += delta;
            patchBot({ response: { answer: accumulated } });
          },
          onDone: (metadata) => {
            // Replace the response with the final metadata + the
            // accumulated answer text. Steps get cleared — the
            // evidence panel takes over via tool_calls.
            patchBot({
              response: { ...metadata, answer: accumulated },
              steps: [],
            });
            // GW-16: capture the server-issued conversation id.
            // Turn 1 mints; turn 2+ echoes what we sent. Stored
            // in state so the next handleSubmit quotes it.
            if (metadata.conversation_id) {
              setConversationId(metadata.conversation_id);
            }
          },
        },
        { conversationId },
      );
    } catch (err: unknown) {
      // Network / non-2xx from the stream endpoint. Replace the
      // placeholder with an error bubble so the customer isn't
      // left with an empty bot bubble. Failed query preserved for
      // the retry action.
      const errorText =
        err instanceof ApiError
          ? `Something went wrong on the server (${err.status}). Please try again.`
          : "Couldn't reach the assistant — check your connection and try again.";
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== botId)
          .concat({
            kind: 'error',
            id: nextId(),
            message: errorText,
            failedQuery: trimmed,
          }),
      );
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
      {messages.length > 0 ? (
        <div className={styles.conversationBar}>
          <button
            type="button"
            className={styles.newConversationButton}
            onClick={handleNewConversation}
            disabled={pending}
            aria-label="Start a new conversation"
          >
            New conversation
          </button>
        </div>
      ) : null}
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
        {/* Standalone pending spinner removed — the streaming bot
         * bubble is the loading indicator now. First delta typically
         * arrives within 500ms, so the empty bubble is invisibly
         * brief. A pending typing-indicator INSIDE the bubble is a
         * Sprint-4+ polish item if the first-token latency ever
         * gets slow enough to notice. */}
        <div ref={scrollAnchor} />
      </div>
      <InputBar onSubmit={handleSubmit} disabled={pending} />
    </div>
  );
}
