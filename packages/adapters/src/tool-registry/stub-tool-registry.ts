import {
  NotImplementedError,
  type ToolDefinition,
  type ToolInvocation,
  type ToolRegistry,
  type ToolResult,
} from '@groundwork/core';

export class StubToolRegistry implements ToolRegistry {
  list(): readonly ToolDefinition[] {
    return [];
  }

  async invoke(_call: ToolInvocation, _signal?: AbortSignal): Promise<ToolResult> {
    throw new NotImplementedError('ToolRegistry', 'Sprint 2', 'stock, sizing, delivery-zone tools');
  }
}
