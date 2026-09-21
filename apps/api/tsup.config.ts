import { defineConfig } from 'tsup';

// Bundles apps/api's server for Vercel Functions. The @groundwork/*
// workspace packages ship as .ts source (see their package.json
// exports); Node's ESM resolver in the built function cannot load
// .ts, so tsup inlines them into the output. Heavy third-party
// deps stay external and are resolved from node_modules at runtime.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
  dts: true,
  noExternal: [/^@groundwork\//],
  external: [
    'hono',
    'openai',
    '@supabase/supabase-js',
    '@upstash/ratelimit',
    '@upstash/redis',
    'yaml',
  ],
});
