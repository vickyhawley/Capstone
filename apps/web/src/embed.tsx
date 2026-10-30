/**
 * Chrome-less embed entry — mounted inside a Shopify-side iframe.
 *
 * The iframe loads /embed; this bundle renders Chat and nothing else
 * (no site header, no About-panel toggle). The Article 50 disclosure
 * renders as a notice above the chat so it reads before the user's
 * first question — a side-panel disclosure is too easy to miss on a
 * 400x600 panel.
 *
 * The notice is dismissable, but dismissing collapses it to a
 * one-line "AI assistant" label rather than removing it: ADR-0012
 * requires the disclosure before the first turn *or* in a persistent
 * surface, and the label keeps the second condition true for a
 * customer who dismisses and returns to the tab later. Dismissal is
 * remembered for the browser session only, so a new visit sees the
 * full notice again.
 *
 * Loading posture: fetch /api/about once, then render the notice and
 * Chat. If /api/about is down we degrade to a short inline notice and
 * still render Chat — the main pipeline is probably still live and
 * the panel is useful without the full disclosure text.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { ApiError, getAbout } from './api/client.js';
import { Chat } from './components/Chat.js';
import './embed.css';

const DISMISSED_KEY = 'nfcs-ai-disclosure-dismissed';

// sessionStorage can throw (blocked third-party storage in an iframe,
// private mode), so both accessors fall back to "not dismissed".
function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(dismissed: boolean): void {
  try {
    if (dismissed) {
      window.sessionStorage.setItem(DISMISSED_KEY, '1');
    } else {
      window.sessionStorage.removeItem(DISMISSED_KEY);
    }
  } catch {
    // Storage unavailable — dismissal just won't survive a reload.
  }
}

// Splits off the first sentence ("You're chatting with an AI
// assistant, not a member of the NFCS team.") — the core disclosure,
// always shown. The rest is hidden behind "More" on phones only
// (CSS-gated), so the notice doesn't swallow a small screen.
function splitLead(disclosure: string): { lead: string; rest: string } {
  const breakAt = disclosure.indexOf('. ');
  if (breakAt === -1) return { lead: disclosure, rest: '' };
  return { lead: disclosure.slice(0, breakAt + 1), rest: disclosure.slice(breakAt + 2) };
}

function DisclosureNotice({ disclosure }: { readonly disclosure: string }) {
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [expanded, setExpanded] = useState(false);
  const { lead, rest } = splitLead(disclosure);

  function updateDismissed(next: boolean): void {
    setDismissed(next);
    writeDismissed(next);
  }

  if (dismissed) {
    return (
      <div className="embed-disclosure-collapsed">
        <span>You're chatting with an AI assistant.</span>
        <button
          type="button"
          className="embed-disclosure-link"
          onClick={() => updateDismissed(false)}
        >
          About this assistant
        </button>
      </div>
    );
  }

  return (
    <aside className="embed-disclosure" aria-label="AI disclosure">
      <p className="embed-disclosure-text">
        {lead}
        {rest ? (
          <>
            {' '}
            <span
              className={
                expanded
                  ? 'embed-disclosure-rest'
                  : 'embed-disclosure-rest embed-disclosure-rest--collapsed'
              }
            >
              {rest}
            </span>
            <button
              type="button"
              className="embed-disclosure-more"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {expanded ? 'Less' : 'More'}
            </button>
          </>
        ) : null}
      </p>
      <button
        type="button"
        className="embed-disclosure-dismiss"
        onClick={() => updateDismissed(true)}
        aria-label="Dismiss AI notice"
      >
        ×
      </button>
    </aside>
  );
}

type AboutState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly disclosure: string }
  | { readonly kind: 'error'; readonly message: string };

function Embed() {
  const [state, setState] = useState<AboutState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getAbout()
      .then((about) => {
        if (cancelled) return;
        setState({ kind: 'ready', disclosure: about.disclosure });
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
      <DisclosureNotice disclosure={state.disclosure} />
      <Chat />
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
