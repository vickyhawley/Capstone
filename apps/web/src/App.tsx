import { useEffect, useState } from 'react';

type HealthState = 'checking' | 'ok' | 'unreachable';

export function App() {
  const [health, setHealth] = useState<HealthState>('checking');
  const [streamChunks, setStreamChunks] = useState<string[]>([]);
  const [streamStatus, setStreamStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(() => {
        if (!cancelled) setHealth('ok');
      })
      .catch(() => {
        if (!cancelled) setHealth('unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function runStream() {
    setStreamChunks([]);
    setStreamStatus('running');
    const es = new EventSource('/api/stream/demo');
    es.addEventListener('token', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as { text: string };
        setStreamChunks((prev) => [...prev, parsed.text]);
      } catch {
        setStreamStatus('error');
        es.close();
      }
    });
    es.addEventListener('done', () => {
      setStreamStatus('done');
      es.close();
    });
    es.onerror = () => {
      setStreamStatus('error');
      es.close();
    };
  }

  return (
    <main>
      <h1>Groundwork</h1>
      <p>Scaffold shell. No product features yet — Sprint 0 only.</p>

      <section aria-labelledby="health-heading">
        <h2 id="health-heading">API health</h2>
        <p>
          Status:{' '}
          <span
            className={
              health === 'ok' ? 'status-ok' : health === 'unreachable' ? 'status-fail' : ''
            }
          >
            {health}
          </span>
        </p>
      </section>

      <section aria-labelledby="stream-heading">
        <h2 id="stream-heading">Streaming smoke test</h2>
        <p>
          Verifies SSE end to end: browser &rarr; Vercel rewrite &rarr; API function &rarr; back. If
          this works, Sprint 1 can rely on the same path for token streaming.
        </p>
        <button type="button" onClick={runStream} disabled={streamStatus === 'running'}>
          {streamStatus === 'running' ? 'Streaming…' : 'Run stream'}
        </button>
        <p>Status: {streamStatus}</p>
        <ol>
          {streamChunks.map((chunk, i) => (
            <li key={`${i}-${chunk}`}>{chunk}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
