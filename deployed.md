# Deployed version

The AI Engineering Project brief marks deployment as optional. Groundwork
is publicly deployed on Vercel:

- **Web (chat UI)** — <https://capstone-web-ten.vercel.app>
- **API (direct)** — <https://groundwork-api.vercel.app/api/health>

Try the chat directly:
1. Open the web URL above.
2. Type a question like *"do you sell hemp bedding?"* or
   *"do you deliver to SO41?"* or *"what size rug for a narrow
   thoroughbred?"*
3. Answers stream in with product links + evidence panel.

## Verify the deployment is live

```bash
curl https://capstone-web-ten.vercel.app/api/health
# → {"status":"ok","service":"groundwork-api","version":"0.0.1",...}
```

## Architecture

Two Vercel projects deploy from this monorepo:

- `groundwork-web` — the React + Vite frontend at `apps/web/`.
- `groundwork-api` — the Hono API at `apps/api/`, running on Vercel's
  modern Node runtime.

The web project has a same-origin rewrite that forwards `/api/*` to the
API project, so browser requests never hit CORS. See
`docs/design-and-testing.md` §"Deployment options" for the reasoning.

## Naming note

The public web alias is still `capstone-web-ten.vercel.app` (the
original scaffold name) because Vercel's Hobby plan doesn't allow
adding new `*.vercel.app` aliases after the fact. The underlying
Vercel project itself is renamed to `groundwork-web`; only the
auto-minted public alias carries the older name.
