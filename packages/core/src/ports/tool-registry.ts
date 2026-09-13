/**
 * ToolRegistry port.
 *
 * Deterministic tools that the pipeline calls for facts the model must not
 * guess (stock, sizing, delivery zones, price). The registry exposes a
 * schema per tool for planner prompting and a strict invoke path.
 *
 * Assumes:
 * - Tool schemas are static and known at startup. Runtime registration is
 *   out of scope.
 * - `invoke` validates its `args` against the tool's schema; on failure it
 *   returns a structured error rather than throwing.
 * - Tool execution is idempotent unless the tool's own schema declares
 *   otherwise; the pipeline may retry on transient failure.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface ToolInvocation {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export type ToolResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

export interface ToolRegistry {
  list(): readonly ToolDefinition[];
  invoke(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult>;
}
