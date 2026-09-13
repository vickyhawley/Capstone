import { handle } from 'hono/vercel';
import { app } from '../src/server.js';

// Vercel Functions entrypoint. The `[[...route]]` catch-all forwards every
// request path to the Hono app; runtime is pinned in vercel.json.
export default handle(app);
