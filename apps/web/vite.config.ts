import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Local dev proxies /api to the api app on port 8787 so the browser sees
// a single origin — matching the Vercel rewrite in production.
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
  test: {
    environment: 'jsdom',
  },
});
