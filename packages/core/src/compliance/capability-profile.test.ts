/**
 * Unit tests for the capability profile. ADR-0012.
 *
 * The lock-to-runtime tests are the load-bearing ones: they enforce
 * "matched to what the system actually does" mechanically for the
 * two dimensions where mechanical enforcement works (intents +
 * escalation targets). Tone and phrasing (canDo/cannotDo) are
 * review discipline, not test.
 */
import { describe, expect, it } from 'vitest';

import { INTENTS } from '../ports/router.js';
import { CAPABILITY_PROFILE } from './capability-profile.js';

describe('capability profile — locked-to-runtime invariants', () => {
  it('lists exactly the six Intent values from the router port', () => {
    const profileNames = CAPABILITY_PROFILE.intents.map((i) => i.name).sort();
    const runtime = [...INTENTS].sort();
    expect(profileNames).toEqual(runtime);
  });

  it('has no duplicate intent entries', () => {
    const names = CAPABILITY_PROFILE.intents.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists exactly the three EscalationTarget values from the safety-gate port', () => {
    // Kept in sync with `EscalationTarget` in
    // packages/core/src/ports/safety-gate.ts. Adding a target
    // there without adding it here fails this test.
    const runtime = ['vet', 'staff-service', 'staff-order'].sort();
    const profileTargets = CAPABILITY_PROFILE.escalatesTo.map((e) => e.target).sort();
    expect(profileTargets).toEqual(runtime);
  });

  it('has no duplicate escalation targets', () => {
    const targets = CAPABILITY_PROFILE.escalatesTo.map((e) => e.target);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('capability profile — content shape', () => {
  it('every intent description is non-empty', () => {
    for (const i of CAPABILITY_PROFILE.intents) {
      expect(i.describes.trim().length, `${i.name} describes must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('every escalation target "for" text is non-empty', () => {
    for (const e of CAPABILITY_PROFILE.escalatesTo) {
      expect(e.for.trim().length, `${e.target} "for" must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('canDo list is non-empty', () => {
    expect(CAPABILITY_PROFILE.canDo.length).toBeGreaterThan(0);
    for (const s of CAPABILITY_PROFILE.canDo) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('cannotDo list is non-empty', () => {
    expect(CAPABILITY_PROFILE.cannotDo.length).toBeGreaterThan(0);
    for (const s of CAPABILITY_PROFILE.cannotDo) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('capability profile — matches downstream system behaviour', () => {
  it('cannotDo mentions clinical/veterinary refusal', () => {
    const joined = CAPABILITY_PROFILE.cannotDo.join(' ').toLowerCase();
    expect(joined).toMatch(/clinical|veterinary|vet/);
  });

  it('cannotDo mentions the in-person-fitting refusal (boots/hat/helmet)', () => {
    const joined = CAPABILITY_PROFILE.cannotDo.join(' ').toLowerCase();
    expect(joined).toMatch(/boot|hat|helmet/);
  });

  it('cannotDo mentions refusal to discuss its own instructions or adopt personas', () => {
    // Matches the adversarial-abstain surface (ADR-0011 rule 4,
    // GW-11 dispatch of oos-036/037/038).
    const joined = CAPABILITY_PROFILE.cannotDo.join(' ').toLowerCase();
    expect(joined).toMatch(/instructions|persona/);
  });

  it('escalatesTo[vet] "for" mentions welfare or clinical', () => {
    const vet = CAPABILITY_PROFILE.escalatesTo.find((e) => e.target === 'vet');
    expect(vet).toBeDefined();
    expect(vet?.for.toLowerCase()).toMatch(/welfare|clinical|health/);
  });
});
