import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Local dev proxies /api to the api app on port 8787 so the browser sees
// a single origin — matching the Vercel rewrite in production.
//
// Two HTML entries:
//  - index.html — the full web app with site chrome.
//  - embed.html — chrome-less chat for the Shopify iframe. Keeps a
//    separate bundle so the Shopify panel doesn't ship the Header /
//    AboutPanel code it never renders. Vite emits it as dist/embed.html;
//    vercel.json rewrites /embed to it and sets the frame-ancestors CSP.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        embed: resolve(__dirname, 'embed.html'),
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
