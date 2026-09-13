#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Core purity check.
//
// packages/core is the domain layer. Its contract, called out in the
// architecture doc, is that it depends on nothing framework-, SDK- or
// HTTP-client-shaped. That contract is what lets the eval harness swap
// fakes in for real adapters. This script enforces the contract in CI so
// nobody accidentally reaches for a library and turns the port abstraction
// into a leaky one.
//
// Rules enforced:
//   1. packages/core/package.json declares no runtime `dependencies`.
//   2. No .ts file in packages/core/src imports a Node built-in.
//   3. No .ts file in packages/core/src imports an external (non-relative)
//      package except via `import type`.
//
// Test files (*.test.ts, *.spec.ts) are excluded.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = process.cwd();
const CORE_DIR = join(REPO_ROOT, 'packages', 'core');
const SRC_DIR = join(CORE_DIR, 'src');
const PKG_JSON = join(CORE_DIR, 'package.json');

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

const failures = [];

// Rule 1: no runtime deps
const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
if (runtimeDeps.length > 0) {
  failures.push(
    `packages/core/package.json declares runtime dependencies: ${runtimeDeps.join(', ')}. Core must be dependency-free.`,
  );
}

// Walk src for .ts files (excluding test files)
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walk(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

// Matches:
//   import 'x';
//   import type X from 'x';
//   import type { X } from 'x';
//   import X from 'x';
//   import { X, Y } from 'x';
//   import * as X from 'x';
const IMPORT_RE = /^\s*import\s+(type\s+)?(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm;

function classifySpecifier(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return 'relative';
  if (spec.startsWith('node:')) return 'node';
  const head = spec.split('/')[0];
  if (NODE_BUILTINS.has(head)) return 'node';
  return 'external';
}

for (const file of walk(SRC_DIR)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(REPO_ROOT, file);
  for (const match of src.matchAll(IMPORT_RE)) {
    const isTypeOnly = Boolean(match[1]);
    const spec = match[2];
    const kind = classifySpecifier(spec);
    if (kind === 'relative') continue;
    if (kind === 'node') {
      failures.push(`${rel}: imports Node built-in "${spec}". Core must not use Node APIs.`);
      continue;
    }
    if (!isTypeOnly) {
      failures.push(
        `${rel}: non-type import from "${spec}". Core may only "import type" from external packages.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Core purity check failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('Core purity check passed.');
