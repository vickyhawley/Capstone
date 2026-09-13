import { handle } from 'hono/vercel';
import { app } from '../src/server.js';

/**
 * Vercel Functions entrypoint. The `[[...route]]` catch-all forwards
 * every request path to the Hono app, so route definitions live in one
 * place regardless of runtime.
 */
export const config = {
  runtime: 'nodejs',
};

export default handle(app);
