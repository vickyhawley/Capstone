/**
 * Web-side type declarations for the API contracts. Sprint 4 (UI).
 *
 * Kept as a hand-written mirror of the API's response shapes rather
 * than imported from `@groundwork/api` — the web workspace has no
 * dependency on the api workspace's Hono / server plumbing, only on
 * its network contract. If the API adds a field, add it here too;
 * the eval harness's Python `ApiResponse` in
 * `evals/groundwork_evals/schema.py` is the source of truth if the
 * two ever disagree.
 */

export type Intent =
  | 'product'
  | 'fit'
  | 'logistics'
  | 'welfare-clinical'
  | 'out-of-scope'
  | 'service-referral';

export type Behaviour = 'answer' | 'abstain' | 'escalate';

export type EscalationTarget = 'vet' | 'staff-service' | 'staff-order';

export type DeliveryZoneStatus = 'within_radius' | 'defer_to_staff';

export interface ToolCallSummary {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly ok: boolean;
  readonly duration_ms: number;
}

export interface ProductLink {
  readonly handle: string;
  readonly title: string | null;
  readonly url: string;
  readonly priceMin: number | null;
  readonly priceMax: number | null;
}

export interface AnswerResponse {
  readonly answer: string;
  readonly citations: readonly unknown[];
  readonly retrieved_chunk_ids: readonly string[];
  readonly refusal_reason: string | null;
  readonly trace_id: string | null;
  readonly intent: Intent | null;
  readonly adversarial_suspected: boolean;
  readonly adversarial_pattern: string | null;
  readonly product_query: string | null;
  readonly behavior: Behaviour;
  readonly escalation_target: EscalationTarget | null;
  readonly tool_calls: readonly ToolCallSummary[];
  readonly substitute_handles: readonly string[];
  readonly delivery_zone_status: DeliveryZoneStatus | null;
  readonly product_links: readonly ProductLink[];
  readonly degraded_reason?: string | null;
}

export interface AboutResponse {
  readonly disclosure: string;
  readonly capability_profile: {
    readonly can_do: readonly string[];
    readonly cannot_do: readonly string[];
    readonly escalates_to: readonly {
      readonly target: EscalationTarget;
      readonly for: string;
    }[];
    readonly intents: readonly {
      readonly name: Intent;
      readonly describes: string;
    }[];
  };
}
