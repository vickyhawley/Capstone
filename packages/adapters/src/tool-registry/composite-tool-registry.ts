/**
 * CompositeToolRegistry. GW-19 wiring (2026-09-18).
 *
 * Composes multiple single-tool registries into one. Each child
 * registry advertises exactly one tool today (ProductStockLookupTool,
 * ProductSubstituteLookupTool); the composite dispatches an invoke
 * call to whichever child's `list()` claims the requested tool name.
 *
 * The alternative — collapsing tools into a single registry class —
 * bundles unrelated concerns for no observability gain. Keeping tools
 * separable + composing at the registry level lets each tool own its
 * own dependencies, tests, and trace span; the composite is a small
 * dispatcher, nothing more.
 */

import type { ToolDefinition, ToolInvocation, ToolRegistry, ToolResult } from '@groundwork/core';

export class CompositeToolRegistry implements ToolRegistry {
  constructor(private readonly registries: readonly ToolRegistry[]) {}

  list(): readonly ToolDefinition[] {
    return this.registries.flatMap((r) => r.list());
  }

  async invoke(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult> {
    for (const registry of this.registries) {
      if (registry.list().some((def) => def.name === call.name)) {
        return registry.invoke(call, signal);
      }
    }
    return {
      ok: false,
      error: `tool not found: ${call.name} (composite registry has ${this.registries.length} child registries, none claim this tool)`,
      retryable: false,
    };
  }
}
