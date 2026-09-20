import { useEffect, useState } from 'react';

import { ApiError, getAbout } from '../api/client.js';
import type { AboutResponse } from '../api/types.js';
import styles from './AboutPanel.module.css';

interface AboutPanelProps {
  readonly id: string;
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: AboutResponse }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Renders the Article 50 disclosure and capability profile from
 * /api/about. Fetched lazily on mount — the parent only renders
 * this component when the user has toggled the panel open.
 */
export function AboutPanel({ id }: AboutPanelProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getAbout()
      .then((data) => {
        if (!cancelled) setState({ kind: 'ready', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiError
            ? `Couldn't load — ${err.status}`
            : err instanceof Error
              ? err.message
              : 'Unknown error';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <section id={id} className={styles.panel}>
        <p>Loading disclosure…</p>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section id={id} className={styles.panel}>
        <p className={styles.error}>Couldn't load the disclosure: {state.message}</p>
      </section>
    );
  }

  const { disclosure, capability_profile: profile } = state.data;
  return (
    <section id={id} className={styles.panel}>
      <h2 className={styles.heading}>AI disclosure</h2>
      <p className={styles.disclosure}>{disclosure}</p>

      <h3 className={styles.subheading}>What this assistant can do</h3>
      <ul className={styles.list}>
        {profile.can_do.map((item, i) => (
          <li key={`can-${i}`}>{item}</li>
        ))}
      </ul>

      <h3 className={styles.subheading}>What this assistant cannot do</h3>
      <ul className={styles.list}>
        {profile.cannot_do.map((item, i) => (
          <li key={`cannot-${i}`}>{item}</li>
        ))}
      </ul>

      <h3 className={styles.subheading}>When it escalates to a person</h3>
      <ul className={styles.list}>
        {profile.escalates_to.map((esc, i) => (
          <li key={`esc-${i}`}>
            <strong>{esc.target}:</strong> {esc.for}
          </li>
        ))}
      </ul>
    </section>
  );
}
