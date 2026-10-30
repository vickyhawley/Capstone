import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Regression guard — see embed brief §7(c).
 *
 * The embed widget rides same-origin to /api/* via the Vercel
 * rewrite in apps/web/vercel.json, so the API deliberately does
 * NOT set CORS headers. A reviewer or future refactor who "fixes a
 * missing CORS header" without reading this comment would add
 * dead-weight that risks breaking the current working path. This
 * test fails if any apps/api/src source file mentions
 * Access-Control-* headers or Hono's cors middleware, outside this
 * test file itself.
 */

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no CORS code in apps/api/src', () => {
  const srcDir = TEST_DIR;
  const files = listTsFiles(srcDir).filter((p) => !p.endsWith('no-cors.test.ts'));

  it.each(files)('%s has no Access-Control-* or hono/cors reference', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/Access-Control-/i);
    expect(text).not.toMatch(/from ['"]hono\/cors['"]/);
    expect(text).not.toMatch(/\bcors\(/);
  });
});
