#!/usr/bin/env node
// Post-deploy smoke check. Curls both /api/health endpoints and asserts:
//   - HTTP 200
//   - JSON body has status === 'ok' and rateLimit.configured === true
//   - Web-origin response body matches API-origin response body
//
// Failure is loud (non-zero exit + a labelled line) so a CI job's red X
// answers "which check failed?" without needing to open the logs.
//
// Runnable locally (`pnpm smoke`) and in CI (.github/workflows/smoke.yml).
// Retries with backoff so a just-triggered deploy has time to propagate.
//
// URLs are hardcoded because they're stable Vercel aliases; if either
// changes, update here and in README.md's "Deployed URL" section.

const API_URL = 'https://groundwork-api.vercel.app/api/health';
const WEB_URL = 'https://capstone-web-ten.vercel.app/api/health';

const RETRIES = 6;
const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000, 60000];

/**
 * @typedef {Object} HealthPayload
 * @property {string} status
 * @property {string} service
 * @property {string} version
 * @property {{maxIterations:number,timeBudgetMs:number}} limits
 * @property {{configured:boolean}} rateLimit
 */

/**
 * @param {string} url
 * @returns {Promise<{status:number, body:HealthPayload|string}>}
 */
async function fetchHealth(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * @param {string} label
 * @param {string} url
 * @returns {Promise<HealthPayload>}
 */
async function assertHealthy(label, url) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const { status, body } = await fetchHealth(url);
      if (status !== 200) throw new Error(`status ${status}, body: ${JSON.stringify(body)}`);
      if (typeof body === 'string') throw new Error(`non-JSON body: ${body.slice(0, 200)}`);
      if (body.status !== 'ok') throw new Error(`status field is "${body.status}", expected "ok"`);
      if (body.rateLimit?.configured !== true) {
        throw new Error(`rateLimit.configured is ${body.rateLimit?.configured}, expected true`);
      }
      console.log(`[${label}] ok`);
      return body;
    } catch (err) {
      const isLast = attempt === RETRIES;
      const msg = err instanceof Error ? err.message : String(err);
      if (isLast) throw new Error(`[${label}] failed after ${RETRIES + 1} attempts: ${msg}`);
      const delay = BACKOFF_MS[attempt] ?? 60000;
      console.log(`[${label}] attempt ${attempt + 1} failed (${msg}) — retry in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error('smoke check exhausted retries');
}

/**
 * Assert that two /api/health payloads are effectively identical.
 * The Vercel-generated headers differ every request, so we compare the
 * JSON body, not the response envelope. Version and limits must match so
 * a stale-cached web edge can't silently mask an API redeploy.
 */
function assertPayloadsMatch(apiBody, webBody) {
  const keys = ['status', 'service', 'version', 'rateLimit'];
  for (const k of keys) {
    const a = JSON.stringify(apiBody[k]);
    const w = JSON.stringify(webBody[k]);
    if (a !== w) {
      throw new Error(`payload diverges on "${k}": api=${a} web=${w}`);
    }
  }
  const aLim = apiBody.limits;
  const wLim = webBody.limits;
  if (aLim.maxIterations !== wLim.maxIterations || aLim.timeBudgetMs !== wLim.timeBudgetMs) {
    throw new Error(`limits diverge: api=${JSON.stringify(aLim)} web=${JSON.stringify(wLim)}`);
  }
  console.log('[match] api and web payloads agree on status/service/version/limits/rateLimit');
}

async function main() {
  console.log(`API: ${API_URL}`);
  console.log(`Web: ${WEB_URL}`);
  const apiBody = await assertHealthy('api', API_URL);
  const webBody = await assertHealthy('web', WEB_URL);
  assertPayloadsMatch(apiBody, webBody);
  console.log('smoke: PASS');
}

main().catch((err) => {
  console.error(`smoke: FAIL — ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
