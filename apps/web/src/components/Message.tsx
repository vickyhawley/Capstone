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
}

export type Message = UserMessage | BotMessage | ErrorMessage;

interface MessageBubbleProps {
  readonly message: Message;
}

/**
 * Single message bubble. User messages render text plain. Bot
 * messages render the API response's `answer` copy + a collapsible
 * evidence panel showing the trust receipts (tool_calls, intent,
 * tool outputs, trace_id). Error messages render a subtle failure
 * indicator.
 *
 * The evidence panel is collapsed by default — the customer-real
 * story is "here's the answer"; the evaluator-real story is
 * "show what I checked" one click away.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
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
      </div>
    );
  }

  return <BotMessageBubble response={message.response} />;
}

function BotMessageBubble({ response }: { readonly response: AnswerResponse }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
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
      </div>

      {evidenceOpen ? <EvidencePanel response={response} toolCount={toolCount} /> : null}
    </div>
  );
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
        {response.intent ? (
          <>
            <dt>Intent</dt>
            <dd>{response.intent}</dd>
          </>
        ) : null}
        {response.product_query ? (
          <>
            <dt>Product query</dt>
            <dd>{response.product_query}</dd>
          </>
        ) : null}
        {response.behavior !== 'answer' ? (
          <>
            <dt>Behaviour</dt>
            <dd>
              {response.behavior}
              {response.escalation_target ? ` → ${response.escalation_target}` : ''}
              {response.refusal_reason ? ` (${response.refusal_reason})` : ''}
            </dd>
          </>
        ) : null}
        {response.degraded_reason ? (
          <>
            <dt>Degraded reason</dt>
            <dd className={styles.degradedReason}>{response.degraded_reason}</dd>
          </>
        ) : null}
        {response.delivery_zone_status ? (
          <>
            <dt>Delivery zone</dt>
            <dd>{response.delivery_zone_status}</dd>
          </>
        ) : null}
        {response.substitute_handles.length > 0 ? (
          <>
            <dt>Substitutes</dt>
            <dd>{response.substitute_handles.join(', ')}</dd>
          </>
        ) : null}
        {response.product_links.length > 0 ? (
          <>
            <dt>Product links</dt>
            <dd>{response.product_links.map((l) => l.handle).join(', ')}</dd>
          </>
        ) : null}
        {response.trace_id ? (
          <>
            <dt>Trace</dt>
            <dd className={styles.trace}>{response.trace_id}</dd>
          </>
        ) : null}
        {response.adversarial_suspected ? (
          <>
            <dt>Safety signal</dt>
            <dd>{response.adversarial_pattern ?? 'adversarial-suspected'}</dd>
          </>
        ) : null}
      </dl>

      {toolCount > 0 ? (
        <>
          <h4 className={styles.evidenceHeading}>Tools called</h4>
          <ul className={styles.toolList}>
            {response.tool_calls.map((call, i) => (
              <li key={`${call.name}-${i}`} className={styles.toolItem}>
                <code>{call.name}</code>
                <span className={styles.toolMeta}>
                  {call.ok ? 'ok' : 'failed'} · {call.duration_ms}ms
                </span>
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
 * "Show what I checked · N tools" / "Show details" (no tools ran)
 * / "Show why I escalated" (behaviour non-answer).
 */
function summariseTools(response: AnswerResponse): string {
  if (response.behavior === 'escalate') return 'Show why I escalated';
  if (response.behavior === 'abstain') return 'Show why I declined';
  const n = response.tool_calls.length;
  if (n === 0) return 'Show details';
  return `Show what I checked · ${n} tool${n === 1 ? '' : 's'}`;
}
