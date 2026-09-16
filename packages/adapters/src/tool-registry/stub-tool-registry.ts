/**
 * StubToolRegistry. Empty registry that satisfies the port contract.
 *
 * `list()` returns []. `invoke()` returns a structured error result
 * (`ok: false, retryable: false`) — matching the ToolRegistry port
 * docstring: "on failure it returns a structured error rather than
 * throwing." The pre-GW-18 version threw `NotImplementedError` from
 * invoke, which violated the port contract — any loop that tried to
 * call a tool would kill the whole request instead of getting a
 * structured error the planner could react to.
 *
 * Ships as the default registry for /api/answer until GW-20 (stock
 * lookup), GW-21 (fit/sizing), and GW-22 (delivery-zone) register
 * real tools. In that regime, NoopPlanner (which never returns
 * `call-tool`) never triggers invoke — but the safe default matters
 * for tests that swap in a non-noop planner against this stub, and
 * for defence-in-depth against a future planner-adapter bug.
 */
import type { ToolDefinition, ToolInvocation, ToolRegistry, ToolResult } from '@groundwork/core';

export class StubToolRegistry implements ToolRegistry {
  list(): readonly ToolDefinition[] {
    return [];
  }

  async invoke(call: ToolInvocation, _signal?: AbortSignal): Promise<ToolResult> {
    return {
      ok: false,
      error: `tool not found: ${call.name} (StubToolRegistry has no tools registered)`,
      retryable: false,
    };
  }
}
