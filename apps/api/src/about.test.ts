import { ARTICLE_50_DISCLOSURE, CAPABILITY_PROFILE, INTENTS } from '@groundwork/core';
import { describe, expect, it } from 'vitest';

import { createAboutRoute } from './about.js';

async function get(app: ReturnType<typeof createAboutRoute>) {
  return app.fetch(new Request('http://test/', { method: 'GET' }));
}

describe('GET /api/about', () => {
  it('returns 200', async () => {
    const res = await get(createAboutRoute());
    expect(res.status).toBe(200);
  });

  it('returns the disclosure verbatim', async () => {
    const res = await get(createAboutRoute());
    const body = (await res.json()) as { disclosure: string };
    expect(body.disclosure).toBe(ARTICLE_50_DISCLOSURE);
  });

  it('returns the capability profile with snake_case keys', async () => {
    const res = await get(createAboutRoute());
    const body = (await res.json()) as {
      capability_profile: {
        can_do: unknown;
        cannot_do: unknown;
        escalates_to: unknown;
        intents: unknown;
      };
    };
    expect(Array.isArray(body.capability_profile.can_do)).toBe(true);
    expect(Array.isArray(body.capability_profile.cannot_do)).toBe(true);
    expect(Array.isArray(body.capability_profile.escalates_to)).toBe(true);
    expect(Array.isArray(body.capability_profile.intents)).toBe(true);
  });

  it('capability profile intents cover every INTENTS value', async () => {
    const res = await get(createAboutRoute());
    const body = (await res.json()) as {
      capability_profile: { intents: { name: string }[] };
    };
    const returned = body.capability_profile.intents.map((i) => i.name).sort();
    expect(returned).toEqual([...INTENTS].sort());
  });

  it('capability profile canDo matches the runtime constant', async () => {
    const res = await get(createAboutRoute());
    const body = (await res.json()) as {
      capability_profile: { can_do: string[] };
    };
    expect(body.capability_profile.can_do).toEqual(CAPABILITY_PROFILE.canDo);
  });
});
