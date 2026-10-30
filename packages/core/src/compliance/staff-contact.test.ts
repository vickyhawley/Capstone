import { describe, expect, it } from 'vitest';

import { DEGRADED_FALLBACK, STAFF_CONTACT } from './staff-contact.js';

/**
 * CI gate: a placeholder slipping through to production would be
 * visible in a customer-facing panel. These tests are the
 * "typecheck-failing TODO" the embed brief asked for — they fail red
 * on any sentinel, so a release pipeline running `pnpm -w test` stops
 * before shipping with "TODO_PHONE" visible.
 */
describe('STAFF_CONTACT', () => {
  it('phone must not be a sentinel placeholder', () => {
    expect(STAFF_CONTACT.phone.startsWith('TODO_')).toBe(false);
  });

  it('email must not be a sentinel placeholder', () => {
    expect(STAFF_CONTACT.email.startsWith('TODO_')).toBe(false);
  });

  it('opening hours must not be a sentinel placeholder', () => {
    expect(STAFF_CONTACT.openingHours.startsWith('TODO_')).toBe(false);
  });
});

describe('DEGRADED_FALLBACK', () => {
  it('must not use veterinary framing', () => {
    const forbidden = ['vet', 'veterinary', 'clinical', 'equine'];
    for (const word of forbidden) {
      expect(DEGRADED_FALLBACK.toLowerCase()).not.toContain(word);
    }
  });

  it('must name NFCS', () => {
    expect(DEGRADED_FALLBACK).toContain('NFCS');
  });
});
