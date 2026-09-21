import { useState } from 'react';

import logoUrl from '../assets/nfcs-logo.png';
import { AboutPanel } from './AboutPanel.js';
import styles from './Header.module.css';

/**
 * Top of the page — the shop's logo as the brand mark, centrally
 * placed and prominent. The About-panel toggle sits in the top-
 * right, positioned absolutely so the logo stays optically centred
 * without the button pushing it off-axis.
 *
 * The alt text carries the shop name for screen readers — the
 * image is decorative-looking but semantically IS the page's
 * primary heading, so `role="img"` + a descriptive alt keeps
 * assistive tech in step.
 */
export function Header() {
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <header className={styles.header}>
      <div className={styles.logoRow}>
        <img
          src={logoUrl}
          alt="New Forest Country Store"
          className={styles.logo}
        />
        <button
          type="button"
          className={styles.aboutButton}
          onClick={() => setAboutOpen((prev) => !prev)}
          aria-expanded={aboutOpen}
          aria-controls="about-panel"
        >
          {aboutOpen ? 'Hide about' : 'About'}
        </button>
      </div>
      {aboutOpen ? <AboutPanel id="about-panel" /> : null}
    </header>
  );
}
