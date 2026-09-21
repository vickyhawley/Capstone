/**
 * ShopInfoTool. Sprint 4 (2026-09-21).
 *
 * Answers "what is your number / where are you / when are you open /
 * how do I order" from `data/nfcs-shop-info.yaml`. Deterministic —
 * no retrieval, no LLM. The tool's whole job is to surface the
 * shop's canonical contact / hours / address / ordering info as
 * structured data the synthesizer can compose into an answer.
 *
 * Motivation: pre-Sprint-4-story-4, "what is your number?" hit the
 * router LLM's `out-of-scope` classification and fell to the abstain
 * copy ("give the shop a call") without giving the number. Real UX
 * failure. The fix is two-part:
 *   - router-side extractShopInfoTopic (rules.ts) forces intent=
 *     logistics + shopInfoTopic hint, bypassing the LLM's
 *     misclassification.
 *   - this tool provides the structured facts the synthesizer needs.
 *
 * The `topic` arg is a HINT for downstream ranking, not a filter.
 * The tool returns the full struct — phone, hours, address,
 * ordering — regardless. Synthesis picks what's relevant to the
 * customer's actual question. Keeps the tool interface stable if
 * topics grow (or are removed) later.
 *
 * Placement: single-tool registry, same pattern as DeliveryZoneTool.
 * Data loaded once at composition root; malformed YAML surfaces as
 * a deps-build error, not a per-request error.
 */

import { readFile } from 'node:fs/promises';

import type { ToolDefinition, ToolInvocation, ToolRegistry, ToolResult } from '@groundwork/core';
import { parse as parseYaml } from 'yaml';

import type { ShopInfoTopic } from '../router/rules.js';

const TOOL_NAME = 'logistics.shop_info';

const VALID_TOPICS: readonly ShopInfoTopic[] = ['contact', 'hours', 'address', 'ordering'];

export interface ShopAddress {
  readonly locality: string;
  readonly postcode: string;
  readonly street: string | null;
}

export interface ShopOpeningHours {
  readonly monday: string;
  readonly tuesday: string;
  readonly wednesday: string;
  readonly thursday: string;
  readonly friday: string;
  readonly saturday: string;
  readonly sunday: string;
}

export interface SubscriptionDelivery {
  readonly description: string;
  /** Category names matching chunk metadata.type — see attribute-
   *  schemas in packages/core. Case-sensitive comparison. */
  readonly eligibleTypes: readonly string[];
}

export interface ShopInfo {
  readonly phone: string;
  readonly messaging: string;
  readonly email: string | null;
  readonly address: ShopAddress;
  readonly openingHours: ShopOpeningHours;
  readonly bankHolidays: string;
  readonly howToOrder: readonly string[];
  readonly deliverySummary: string;
  readonly subscriptionDelivery: SubscriptionDelivery;
}

export interface ShopInfoResult {
  /** Topic hint the caller passed. Echoed back for the trace log
   *  so future readers can see WHY the tool fired (which router
   *  extraction matched). Null when the caller didn't specify. */
  readonly topic: ShopInfoTopic | null;
  readonly info: ShopInfo;
}

interface ShopInfoToolArgs {
  readonly topic?: ShopInfoTopic;
}

// YAML-side shape — snake_case, loose types before validation.
interface ShopInfoYamlAddress {
  readonly locality: string;
  readonly postcode: string;
  readonly street: string | null;
}
interface ShopInfoYamlHours {
  readonly monday: string;
  readonly tuesday: string;
  readonly wednesday: string;
  readonly thursday: string;
  readonly friday: string;
  readonly saturday: string;
  readonly sunday: string;
}
interface ShopInfoYamlSubscription {
  readonly description: string;
  readonly eligible_types: readonly string[];
}
interface ShopInfoYamlFile {
  readonly phone: string;
  readonly messaging: string;
  readonly email: string | null;
  readonly address: ShopInfoYamlAddress;
  readonly opening_hours: ShopInfoYamlHours;
  readonly bank_holidays: string;
  readonly how_to_order: readonly string[];
  readonly delivery_summary: string;
  readonly subscription_delivery: ShopInfoYamlSubscription;
}

export class ShopInfoTool implements ToolRegistry {
  private readonly definition: ToolDefinition = {
    name: TOOL_NAME,
    description:
      "Return the shop's canonical contact details, opening hours, address, and how-to-order lines. Fires for logistics-intent queries asking 'what is your number', 'when are you open', 'where are you', or 'how do I place an order'. The tool returns all fields; the caller filters via the optional `topic` hint.",
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: {
          type: 'string',
          enum: [...VALID_TOPICS],
          description:
            "Optional topic hint — 'contact', 'hours', 'address', or 'ordering'. Does not filter the response; used for observability + downstream ranking.",
        },
      },
      required: [],
    },
  };

  constructor(private readonly info: ShopInfo) {}

  list(): readonly ToolDefinition[] {
    return [this.definition];
  }

  async invoke(call: ToolInvocation, _signal?: AbortSignal): Promise<ToolResult> {
    if (call.name !== TOOL_NAME) {
      return {
        ok: false,
        error: `tool not found: ${call.name} (this registry only serves ${TOOL_NAME})`,
        retryable: false,
      };
    }
    const argsValidation = validateArgs(call.args);
    if (!argsValidation.ok) {
      return { ok: false, error: argsValidation.error, retryable: false };
    }
    const value: ShopInfoResult = {
      topic: argsValidation.value.topic ?? null,
      info: this.info,
    };
    return { ok: true, value };
  }
}

function validateArgs(
  args: Readonly<Record<string, unknown>>,
): { ok: true; value: ShopInfoToolArgs } | { ok: false; error: string } {
  const topic = args['topic'];
  if (topic === undefined) return { ok: true, value: {} };
  if (typeof topic !== 'string') {
    return { ok: false, error: 'topic must be a string when provided' };
  }
  if (!VALID_TOPICS.includes(topic as ShopInfoTopic)) {
    return {
      ok: false,
      error: `topic must be one of ${VALID_TOPICS.join(', ')} — got ${JSON.stringify(topic)}`,
    };
  }
  return { ok: true, value: { topic: topic as ShopInfoTopic } };
}

/**
 * Load and parse the shop-info YAML. Same shape pattern as
 * loadDeliveryDistricts / loadStatusOverrideList. Throws on infra
 * failure — loaded once at composition root.
 */
export async function loadShopInfo(path: string): Promise<ShopInfo> {
  const raw = await readFile(path, 'utf8');
  const parsed = parseYaml(raw) as ShopInfoYamlFile | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`shop-info YAML at ${path} did not parse to an object`);
  }
  const required: readonly (keyof ShopInfoYamlFile)[] = [
    'phone',
    'messaging',
    'address',
    'opening_hours',
    'bank_holidays',
    'how_to_order',
    'delivery_summary',
    'subscription_delivery',
  ];
  for (const key of required) {
    if (parsed[key] === undefined || parsed[key] === null) {
      throw new Error(`shop-info YAML at ${path} missing required field: ${key}`);
    }
  }
  if (typeof parsed.phone !== 'string') {
    throw new Error(`shop-info YAML at ${path}: phone must be a string`);
  }
  if (!Array.isArray(parsed.how_to_order)) {
    throw new Error(`shop-info YAML at ${path}: how_to_order must be an array`);
  }
  if (
    typeof parsed.subscription_delivery !== 'object' ||
    typeof parsed.subscription_delivery.description !== 'string' ||
    !Array.isArray(parsed.subscription_delivery.eligible_types)
  ) {
    throw new Error(
      `shop-info YAML at ${path}: subscription_delivery must be an object with description (string) and eligible_types (array)`,
    );
  }
  return {
    phone: parsed.phone,
    messaging: parsed.messaging,
    email: parsed.email ?? null,
    address: {
      locality: parsed.address.locality,
      postcode: parsed.address.postcode,
      street: parsed.address.street ?? null,
    },
    openingHours: {
      monday: parsed.opening_hours.monday,
      tuesday: parsed.opening_hours.tuesday,
      wednesday: parsed.opening_hours.wednesday,
      thursday: parsed.opening_hours.thursday,
      friday: parsed.opening_hours.friday,
      saturday: parsed.opening_hours.saturday,
      sunday: parsed.opening_hours.sunday,
    },
    bankHolidays: parsed.bank_holidays,
    howToOrder: parsed.how_to_order,
    deliverySummary: parsed.delivery_summary,
    subscriptionDelivery: {
      description: parsed.subscription_delivery.description,
      eligibleTypes: parsed.subscription_delivery.eligible_types,
    },
  };
}
