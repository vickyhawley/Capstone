/**
 * Thrown by adapter stubs that haven't been implemented yet.
 *
 * Every adapter in `packages/adapters` currently throws this so the
 * scaffold is self-documenting: running the app surfaces exactly which
 * ports still need wiring. The message names the port and points to the
 * sprint where implementation is planned.
 */
export class NotImplementedError extends Error {
  readonly port: string;
  readonly plannedFor: string;

  constructor(port: string, plannedFor: string, detail?: string) {
    const suffix = detail ? ` — ${detail}` : '';
    super(`${port} adapter is not implemented (planned for ${plannedFor})${suffix}`);
    this.name = 'NotImplementedError';
    this.port = port;
    this.plannedFor = plannedFor;
  }
}
