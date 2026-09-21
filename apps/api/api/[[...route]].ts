import { app } from '../dist/server.js';

// Vercel Functions entrypoint. The `[[...route]]` catch-all forwards every
// request path to the Hono app. Vercel's modern Node runtime expects named
// HTTP-method exports returning `Response`, so we route each verb through
// Hono's Web-standard `app.fetch`.
//
// Imports from `../dist/server.js` (tsup output), not `../src/server.js`.
// The @groundwork/* workspace packages ship as .ts source, which Node's
// ESM resolver in the deployed function cannot load. tsup inlines them
// into `dist/server.js`. See tsup.config.ts.
const handler = (request: Request): Response | Promise<Response> => app.fetch(request);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
