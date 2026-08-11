/**
 * Adapter registry.
 *
 * Agent-neutral by construction: it stores `AgentAdapter` instances keyed by `AgentId` and
 * knows nothing about who implements them. Claude registers a Claude adapter, Codex a
 * Codex adapter, and the orchestrator resolves either through the same interface.
 */

import { BridgeError, ErrorCode, type AdapterRegistry, type AgentAdapter, type AgentId } from "@bridge/protocol";

export class SimpleAdapterRegistry implements AdapterRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    const agent = adapter.info.agent;
    const existing = this.adapters.get(agent);
    if (existing && existing !== adapter) {
      // Silently replacing would let a second registration hijack delegations aimed at the
      // first, with no signal to either agent that it happened.
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        `an adapter for '${agent}' is already registered (${existing.info.implementation}); ` +
          `unregister it before registering ${adapter.info.implementation}`,
        { agent, existing: existing.info.implementation, incoming: adapter.info.implementation },
      );
    }
    this.adapters.set(agent, adapter);
  }

  unregister(agent: AgentId): boolean {
    return this.adapters.delete(agent);
  }

  get(agent: AgentId): AgentAdapter | undefined {
    return this.adapters.get(agent);
  }

  list(): readonly AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
