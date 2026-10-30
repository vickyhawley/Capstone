/**
 * Chrome-less embed entry — mounted inside a Shopify-side iframe.
 *
 * The iframe loads /embed; this bundle renders Chat and nothing else
 * (no site header, no About-panel toggle). The Article 50 disclosure
 * is seeded as the first bot message so it reads before the user's
 * first question — a side-panel disclosure is too easy to miss on a
 * 400x600 panel.
 *
 * Loading posture: fetch /api/about once, build the seed message
 * from the response, then render Chat. If /api/about is down we
 * degrade to a short inline notice and still render Chat without a
 * seed — the main pipeline is probably still live and the panel is
 * useful without the preamble.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { ApiError, getAbout } from './api/client.js';
import type { AnswerResponse } from './api/types.js';
import { Chat } from './components/Chat.js';
import type { Message } from './components/Message.js';
import './embed.css';

function buildDisclosureSeed(disclosure: string): Message {
  const synthetic: AnswerResponse = {
    answer: disclosure,
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
  return { kind: 'bot', id: 'disclosure-seed', response: synthetic };
}

type SeedState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly seed: readonly Message[] }
  | { readonly kind: 'error'; readonly message: string };

function Embed() {
  const [state, setState] = useState<SeedState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getAbout()
      .then((about) => {
        if (cancelled) return;
        setState({ kind: 'ready', seed: [buildDisclosureSeed(about.disclosure)] });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiError
            ? `Couldn't load the AI disclosure (${err.status}).`
            : "Couldn't load the AI disclosure.";
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="embed-shell">
        <p className="embed-loading">Loading…</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="embed-shell">
        <p className="embed-error">
          <strong>Note:</strong> {state.message} You're still chatting with an AI assistant.
        </p>
        <Chat />
      </div>
    );
  }

  return (
    <div className="embed-shell">
      <Chat initialMessages={state.seed} />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <Embed />
  </StrictMode>,
);
