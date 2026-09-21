import { useState } from 'react';

import type { AnswerResponse } from '../api/types.js';
import styles from './Message.module.css';

export interface UserMessage {
  readonly kind: 'user';
  readonly id: string;
  readonly text: string;
}

export interface BotMessage {
  readonly kind: 'bot';
  readonly id: string;
  readonly response: AnswerResponse;
}

export interface ErrorMessage {
  readonly kind: 'error';
  readonly id: string;
  readonly message: string;
  /** Populated when the failure came from a user submit — retry
   *  re-fires this query. Absent for cold errors that have no
   *  originating query. */
  readonly failedQuery?: string;
}

export type Message = UserMessage | BotMessage | ErrorMessage;

interface MessageBubbleProps {
  readonly message: Message;
  /** Called when the customer clicks retry on an error bubble.
   *  Passes the failed query string; Chat re-submits it. */
  readonly onRetry?: (query: string) => void;
}

/**
 * Single message bubble. User messages render text plain. Bot
 * messages render the API response's `answer` copy + product-link
 * chips + a collapsible evidence panel (trust receipts). Error
 * messages render a subtle failure indicator with a retry action.
 *
 * The evidence panel is collapsed by default — the customer-real
 * story is "here's the answer"; the evaluator-real story is
 * "show what I checked" one click away.
 */
export function MessageBubble({ message, onRetry }: MessageBubbleProps) {
  if (message.kind === 'user') {
    return (
      <div className={`${styles.bubble} ${styles.user}`}>
        <p className={styles.text}>{message.text}</p>
      </div>
    );
  }

  if (message.kind === 'error') {
    return (
      <div className={`${styles.bubble} ${styles.error}`}>
        <p className={styles.text}>{message.message}</p>
        {message.failedQuery && onRetry ? (
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => onRetry(message.failedQuery ?? '')}
          >
            ↻ Retry
          </button>
        ) : null}
      </div>
    );
  }

  return <BotMessageBubble response={message.response} />;
}

type FeedbackChoice = 'up' | 'down' | null;

function BotMessageBubble({ response }: { readonly response: AnswerResponse }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackChoice>(null);
  const isDegraded = response.degraded_reason != null && response.degraded_reason !== '';
  const toolCount = response.tool_calls.length;
  const summary = summariseTools(response);
  const productLinks = response.product_links;

  return (
    <div className={`${styles.bubble} ${styles.bot}`}>
      <p className={styles.text}>{response.answer}</p>

      {productLinks.length > 0 ? (
        <ul className={styles.productLinks} aria-label="Products mentioned">
          {productLinks.map((link) => (
            <li key={link.handle}>
              <a
                className={styles.productChip}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>{link.title ?? link.handle}</span>
                <span aria-hidden="true" className={styles.productChipArrow}>
                  ↗
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.evidenceToggle}
          onClick={() => setEvidenceOpen((prev) => !prev)}
          aria-expanded={evidenceOpen}
        >
          {evidenceOpen ? 'Hide details' : summary}
        </button>
        {isDegraded ? (
          <span className={styles.degradedTag} title={response.degraded_reason ?? ''}>
            degraded path
          </span>
        ) : null}
        {/* Feedback buttons. State-only for demo (no persistence);
         *  a real deployment wires this to a feedback endpoint /
         *  observability system. Once clicked, buttons swap to
         *  a compact "thanks" acknowledgement so the customer
         *  knows their signal landed. */}
        <div className={styles.feedback} aria-label="Was this helpful?">
          {feedback === null ? (
            <>
              <button
                type="button"
                className={styles.feedbackButton}
                onClick={() => setFeedback('up')}
                aria-label="This was helpful"
                title="This was helpful"
              >
                👍
              </button>
              <button
                type="button"
                className={styles.feedbackButton}
                onClick={() => setFeedback('down')}
                aria-label="This wasn't helpful"
                title="This wasn't helpful"
              >
                👎
              </button>
            </>
          ) : (
            <span className={styles.feedbackAck}>
              {feedback === 'up' ? 'Thanks!' : "Thanks — we'll do better."}
            </span>
          )}
        </div>
      </div>

      {evidenceOpen ? <EvidencePanel response={response} toolCount={toolCount} /> : null}
    </div>
  );
}

/**
 * Map internal tool identifiers to plain-English labels the
 * customer can read. Keeping the map here (not in a shared module)
 * because it's UI-shaped copy, not data — a tool rename in
 * adapters/ should prompt a review of this list, not silently
 * fall through.
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  'product.stock_lookup': 'Checked stock',
  'product.substitute_lookup': 'Looked for alternatives',
  'logistics.delivery_zone': 'Verified delivery zone',
  'logistics.shop_info': 'Fetched shop info',
};

function labelForTool(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function EvidencePanel({
  response,
  toolCount,
}: {
  readonly response: AnswerResponse;
  readonly toolCount: number;
}) {
  return (
    <div className={styles.evidence}>
      <dl className={styles.evidenceGrid}>
        {response.product_query ? (
          <>
            <dt>Product</dt>
            <dd>{response.product_query}</dd>
          </>
        ) : null}
        {response.behavior !== 'answer' ? (
          <>
            <dt>Outcome</dt>
            <dd>
              {response.behavior === 'escalate' ? 'Routed to staff' : 'Declined'}
              {response.escalation_target ? ` (${response.escalation_target})` : ''}
            </dd>
          </>
        ) : null}
        {response.degraded_reason ? (
          <>
            <dt>System issue</dt>
            <dd className={styles.degradedReason}>{response.degraded_reason}</dd>
          </>
        ) : null}
        {response.delivery_zone_status ? (
          <>
            <dt>Delivery zone</dt>
            <dd>
              {response.delivery_zone_status === 'within_radius'
                ? 'Within delivery radius'
                : 'Route to staff (edge of / outside radius)'}
            </dd>
          </>
        ) : null}
        {response.substitute_handles.length > 0 ? (
          <>
            <dt>Alternatives shown</dt>
            <dd>{response.substitute_handles.join(', ')}</dd>
          </>
        ) : null}
        {response.adversarial_suspected ? (
          <>
            <dt>Safety signal</dt>
            <dd>Suspicious input detected</dd>
          </>
        ) : null}
        {response.trace_id ? (
          <>
            <dt>Reference</dt>
            <dd className={styles.trace}>{response.trace_id.slice(0, 8)}</dd>
          </>
        ) : null}
      </dl>

      {toolCount > 0 ? (
        <>
          <h4 className={styles.evidenceHeading}>What I did</h4>
          <ul className={styles.toolList}>
            {response.tool_calls.map((call, i) => (
              <li key={`${call.name}-${i}`} className={styles.toolItem}>
                <span className={styles.toolLabel}>
                  {call.ok ? '✓' : '✗'} {labelForTool(call.name)}
                </span>
                <span className={styles.toolMeta}>{call.duration_ms}ms</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/**
 * Short one-line summary for the evidence toggle button.
 * Customer-shaped label — no jargon.
 */
function summariseTools(response: AnswerResponse): string {
  if (response.behavior === 'escalate') return 'Why I routed you to staff';
  if (response.behavior === 'abstain') return "Why I couldn't answer";
  const n = response.tool_calls.length;
  if (n === 0) return 'Show details';
  return `What I checked · ${n} step${n === 1 ? '' : 's'}`;
}
