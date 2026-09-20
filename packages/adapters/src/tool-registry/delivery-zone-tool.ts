/**
 * DeliveryZoneTool. GW-21 (2026-09-18 — third of the four Sprint-3
 * close-scope stories).
 *
 * Answers "do you deliver to <postcode>?" from `data/guides/
 * delivery.md`'s 20-mile radius policy and the curated postcode-
 * district list in `data/delivery-districts.yaml`.
 *
 * Two states, not three:
 *   - `within_radius` — the postcode's outward code is in the
 *     districts list AND flagged `within_radius: true`. Confident
 *     yes.
 *   - `defer_to_staff` — everything else. Known-beyond districts,
 *     unknown postcodes, unparseable input.
 *
 * The delivery guide explicitly names "near the boundary or beyond
 * — do not refuse. Route to staff. The assistant must not be the
 * first thing to enforce it." So there is no `confident_no` state.
 * Building a state the assistant should never emit is dead code;
 * the two-state design applies the guide consistently.
 *
 * On unparseable input: fall through to `defer_to_staff` with a
 * `reason` naming the parse failure. Not a structured error —
 * unparseable input is very likely a real customer whose address
 * didn't match the regex, and refusing here would be exactly the
 * failure the guide's "never refuse" rule exists to prevent.
 *
 * Data source rationale: the districts list is curated road-
 * distance approximations, mirroring `scripts/generate_orders.py::
 * DISTRICTS`. Not a routing engine — the guide's admission is that
 * the boundary hasn't been consistently enforced anyway, so
 * precision below the curated numbers doesn't buy the customer
 * answer anything. Unified source of truth is a Sprint-4 refactor.
 */

import { readFile } from 'node:fs/promises';

import type { ToolDefinition, ToolInvocation, ToolRegistry, ToolResult } from '@groundwork/core';
import { parse as parseYaml } from 'yaml';

const TOOL_NAME = 'logistics.delivery_zone';

/** Max postcode length — full UK postcodes fit in ~8 chars; anything
 *  above 32 is a caller bug or an entire message. */
const MAX_POSTCODE_LENGTH = 32;

/** UK outward-code regex. Captures the outward part of any valid
 *  UK postcode: A9, A9A, A99, AA9, AA9A, AA99. Anchored at both
 *  ends because we peel the inward code off first (see
 *  extractOutwardCode); left-anchor alone lets 'TE1' + '9XY' fuse
 *  into 'TE19' after whitespace is stripped, misclassifying a
 *  Ringwood postcode as a Coventry one. */
const OUTWARD_CODE_RE = /^([A-Z]{1,2}[0-9][A-Z0-9]?)$/;

/** UK inward-code pattern: single digit + two letters, always the
 *  last 3 chars of a full postcode. Matching from the end lets us
 *  parse the outward correctly whether or not the customer typed a
 *  space between outward and inward. */
const INWARD_CODE_RE = /([0-9][A-Z]{2})$/;

export type DeliveryZoneStatus = 'within_radius' | 'defer_to_staff';

export interface DistrictEntry {
  readonly postcode: string;
  readonly locality: string;
  readonly distanceMiles: number;
  readonly withinRadius: boolean;
}

interface DistrictYamlEntry {
  readonly postcode: string;
  readonly locality: string;
  readonly distance_miles: number;
  readonly within_radius: boolean;
}

interface DistrictYamlFile {
  readonly districts: readonly DistrictYamlEntry[];
}

export interface DeliveryZoneResult {
  readonly status: DeliveryZoneStatus;
  readonly postcode: string;                  // canonicalised outward code, or '' if unparseable
  readonly matchedDistrict: DistrictEntry | null;
  readonly reason: string;
}

interface DeliveryZoneToolArgs {
  readonly postcode: string;
}

export class DeliveryZoneTool implements ToolRegistry {
  private readonly definition: ToolDefinition = {
    name: TOOL_NAME,
    description:
      "Look up whether NFCS delivers to a given UK postcode. Uses the shop's curated district list (14 districts around Ringwood; the 20-mile radius from data/guides/delivery.md). Returns two states: within_radius (confident yes) or defer_to_staff (everything else — beyond radius, unknown, unparseable). Never refuses; the guide's own text says the assistant must not be the first to enforce the boundary.",
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        postcode: {
          type: 'string',
          description:
            "UK postcode. Outward code (e.g. 'BH24') or full postcode (e.g. 'BH24 1AA'). Case- and whitespace-tolerant.",
          minLength: 1,
          maxLength: MAX_POSTCODE_LENGTH,
        },
      },
      required: ['postcode'],
    },
  };

  constructor(private readonly districts: readonly DistrictEntry[]) {}

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
    const { postcode: raw } = argsValidation.value;

    const outward = extractOutwardCode(raw);
    if (outward === null) {
      // Unparseable input → defer_to_staff. The tool's whole job is
      // never to be the first thing to refuse. See file header.
      const value: DeliveryZoneResult = {
        status: 'defer_to_staff',
        postcode: '',
        matchedDistrict: null,
        reason: `input ${JSON.stringify(raw)} did not parse to a valid UK outward postcode — route to staff`,
      };
      return { ok: true, value };
    }

    const matched = this.districts.find((d) => d.postcode === outward) ?? null;
    if (matched && matched.withinRadius) {
      const value: DeliveryZoneResult = {
        status: 'within_radius',
        postcode: outward,
        matchedDistrict: matched,
        reason: `${outward} (${matched.locality}, ~${matched.distanceMiles} miles) is within the stated 20-mile radius`,
      };
      return { ok: true, value };
    }
    if (matched) {
      const value: DeliveryZoneResult = {
        status: 'defer_to_staff',
        postcode: outward,
        matchedDistrict: matched,
        reason: `${outward} (${matched.locality}, ~${matched.distanceMiles} miles) is beyond the stated 20-mile radius — route to staff per delivery guide`,
      };
      return { ok: true, value };
    }
    const value: DeliveryZoneResult = {
      status: 'defer_to_staff',
      postcode: outward,
      matchedDistrict: null,
      reason: `${outward} is not in the curated district list — route to staff`,
    };
    return { ok: true, value };
  }
}

/**
 * Extract the outward code from a UK postcode string. Uppercases,
 * strips whitespace, applies the outward-code regex. Returns null
 * when input can't parse — caller falls through to `defer_to_staff`.
 * Exported for unit-testability.
 */
export function extractOutwardCode(raw: string): string | null {
  const normalised = raw.toUpperCase().replace(/\s+/gu, '');
  // Peel any inward code (9AA) off the end first. Prevents 'TE1 9XY'
  // → 'TE19XY' → regex-matches 'TE19' (Coventry) instead of 'TE1'.
  const withoutInward = normalised.replace(INWARD_CODE_RE, '');
  const m = OUTWARD_CODE_RE.exec(withoutInward);
  return m ? (m[1] ?? null) : null;
}

/**
 * Load and parse the delivery-districts YAML file. Same shape as
 * `loadStatusOverrideList` in the stock-lookup tool. Throws on
 * infra failure (file missing, unparseable, malformed entries) —
 * loaded once at composition root; a runtime problem here surfaces
 * as a deps-build error, not a per-request error.
 */
export async function loadDeliveryDistricts(path: string): Promise<readonly DistrictEntry[]> {
  const raw = await readFile(path, 'utf8');
  const parsed = parseYaml(raw) as DistrictYamlFile | null;
  if (!parsed || !Array.isArray(parsed.districts)) {
    throw new Error(`delivery-districts YAML at ${path} did not contain a top-level 'districts' array`);
  }
  const out: DistrictEntry[] = [];
  for (const [i, entry] of parsed.districts.entries()) {
    if (
      typeof entry.postcode !== 'string' ||
      typeof entry.locality !== 'string' ||
      typeof entry.distance_miles !== 'number' ||
      typeof entry.within_radius !== 'boolean'
    ) {
      throw new Error(
        `delivery-districts YAML entry ${i} at ${path} is malformed: ${JSON.stringify(entry)}. Required: {postcode: string, locality: string, distance_miles: number, within_radius: boolean}.`,
      );
    }
    out.push({
      postcode: entry.postcode.toUpperCase(),
      locality: entry.locality,
      distanceMiles: entry.distance_miles,
      withinRadius: entry.within_radius,
    });
  }
  return out;
}

// ---------- helpers ----------

function validateArgs(
  args: Readonly<Record<string, unknown>>,
): { ok: true; value: DeliveryZoneToolArgs } | { ok: false; error: string } {
  const postcode = args['postcode'];
  if (typeof postcode !== 'string' || postcode.trim().length === 0) {
    return { ok: false, error: 'postcode is required and must be a non-empty string' };
  }
  if (postcode.length > MAX_POSTCODE_LENGTH) {
    return {
      ok: false,
      error: `postcode too long (${postcode.length} > ${MAX_POSTCODE_LENGTH})`,
    };
  }
  return { ok: true, value: { postcode } };
}
