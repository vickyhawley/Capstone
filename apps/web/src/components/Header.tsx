import { useState } from 'react';

import { AboutPanel } from './AboutPanel.js';
import styles from './Header.module.css';

/**
 * Top bar with title and Article 50 disclosure toggle. The About
 * panel is lazily rendered — the /api/about fetch only fires when
 * the user opens the panel, not on every page load.
 */
export function Header() {
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>Groundwork</h1>
          <p className={styles.subtitle}>Verified answers for New Forest Country Store</p>
        </div>
        <button
          type="button"
          className={styles.aboutButton}
          onClick={() => setAboutOpen((prev) => !prev)}
          aria-expanded={aboutOpen}
          aria-controls="about-panel"
        >
          {aboutOpen ? 'Hide about' : 'About this assistant'}
        </button>
      </div>
      {aboutOpen ? <AboutPanel id="about-panel" /> : null}
    </header>
  );
}
