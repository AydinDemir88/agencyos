/**
 * Policy Engine — Module 6
 *
 * checkPolicy(bookingParams, policy) → { compliant, violations, warnings }
 *
 * Called during flight search to stamp every offer with a policy_status.
 * Also called at booking creation time as a final gate.
 *
 * violations  → hard rules. Offer is non-compliant. Booking requires
 *               policy_override = true + override_reason.
 * warnings    → soft rules. Informational only (e.g. approval required).
 *               Booking can proceed without override but triggers a workflow.
 *
 * All monetary comparisons are in cents (integer).
 * Cabin tiers are ordered: economy < premium_economy < business < first.
 */

// ---------------------------------------------------------------------------
// Cabin ordering
// ---------------------------------------------------------------------------
const CABIN_TIER = {
  economy         : 0,
  premium_economy : 1,
  business        : 2,
  first           : 3,
};

/**
 * Returns true if `offered` cabin is more expensive than `allowed` cabin.
 * e.g. cabinExceedsPolicy('business', 'economy') → true
 */
function cabinExceedsPolicy(offeredCabin, allowedCabin) {
  const offered  = CABIN_TIER[offeredCabin?.toLowerCase()];
  const allowed  = CABIN_TIER[allowedCabin?.toLowerCase()];
  if (offered === undefined || allowed === undefined) return false;
  return offered > allowed;
}

/**
 * Resolve which cabin rule applies to this offer.
 *
 * @param {boolean} isDomestic
 * @param {number}  flightDurationHours
 * @param {number}  longHaulThresholdHours
 * @param {Object}  policy
 * @returns {{ allowedCabin: string, routeLabel: string }}
 */
function resolveAllowedCabin(isDomestic, flightDurationHours, longHaulThresholdHours, policy) {
  if (isDomestic) {
    return { allowedCabin: policy.domestic_cabin, routeLabel: 'domestic' };
  }
  if (flightDurationHours >= longHaulThresholdHours) {
    return { allowedCabin: policy.intl_long_cabin, routeLabel: `international long-haul (≥${longHaulThresholdHours}h)` };
  }
  return { allowedCabin: policy.intl_short_cabin, routeLabel: `international short-haul (<${longHaulThresholdHours}h)` };
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BookingParams
 * @property {string}  cabinClass            - 'economy' | 'premium_economy' | 'business' | 'first'
 * @property {number}  totalAmountCents       - total fare including taxes + fees
 * @property {number}  baseFareCents          - base fare only
 * @property {boolean} isRefundable           - whether the fare is refundable
 * @property {boolean} isDomestic             - true if origin/dest are in same country
 * @property {number}  flightDurationHours    - e.g. 2.5
 * @property {string}  departureAt            - ISO 8601 datetime
 * @property {string}  [fareBrand]            - optional fare brand name
 *
 * @typedef {Object} PolicyResult
 * @property {boolean}  compliant
 * @property {string[]} violations   - non-compliant rules (hard block)
 * @property {string[]} warnings     - advisory rules (soft, may need approval)
 *
 * @param {BookingParams} params
 * @param {Object}        policy   - row from corporate_travel_policies
 * @returns {PolicyResult}
 */
function checkPolicy(params, policy) {
  // If no policy is configured, everything is compliant
  if (!policy) {
    return { compliant: true, violations: [], warnings: [] };
  }

  const violations = [];
  const warnings   = [];

  const {
    cabinClass,
    totalAmountCents,
    baseFareCents,
    isRefundable,
    isDomestic,
    flightDurationHours,
    departureAt,
  } = params;

  const longHaulThreshold = policy.long_haul_threshold_hours ?? 4;

  // ------------------------------------------------------------------
  // 1. CABIN CLASS
  // ------------------------------------------------------------------
  const { allowedCabin, routeLabel } = resolveAllowedCabin(
    isDomestic,
    flightDurationHours,
    longHaulThreshold,
    policy
  );

  if (cabinExceedsPolicy(cabinClass, allowedCabin)) {
    violations.push(
      `Cabin '${cabinClass}' exceeds the allowed cabin '${allowedCabin}' for ${routeLabel} routes.`
    );
  }

  // ------------------------------------------------------------------
  // 2. FARE CAP
  // ------------------------------------------------------------------
  if (isDomestic && policy.max_domestic_fare != null) {
    if (totalAmountCents > policy.max_domestic_fare) {
      violations.push(
        `Total fare ${formatCents(totalAmountCents)} exceeds the domestic cap of ${formatCents(policy.max_domestic_fare)}.`
      );
    }
  }

  if (!isDomestic && policy.max_intl_fare != null) {
    if (totalAmountCents > policy.max_intl_fare) {
      violations.push(
        `Total fare ${formatCents(totalAmountCents)} exceeds the international cap of ${formatCents(policy.max_intl_fare)}.`
      );
    }
  }

  // ------------------------------------------------------------------
  // 3. ADVANCE BOOKING
  // ------------------------------------------------------------------
  if (policy.min_advance_days != null && departureAt) {
    const daysUntilDeparture = Math.floor(
      (new Date(departureAt) - Date.now()) / (1000 * 60 * 60 * 24)
    );
    if (daysUntilDeparture < policy.min_advance_days) {
      violations.push(
        `Departure is in ${daysUntilDeparture} day(s). Policy requires at least ${policy.min_advance_days} day(s) advance booking.`
      );
    }
  }

  // ------------------------------------------------------------------
  // 4. REFUNDABILITY REQUIREMENT
  // ------------------------------------------------------------------
  if (policy.require_refundable_above != null) {
    if (totalAmountCents >= policy.require_refundable_above && !isRefundable) {
      violations.push(
        `Fares above ${formatCents(policy.require_refundable_above)} must be refundable. This fare is non-refundable.`
      );
    }
  }

  // ------------------------------------------------------------------
  // 5. APPROVAL THRESHOLD  (warning — not a hard block)
  // ------------------------------------------------------------------
  if (policy.require_approval_above != null) {
    if (totalAmountCents >= policy.require_approval_above) {
      warnings.push(
        `Fare ${formatCents(totalAmountCents)} meets or exceeds the approval threshold of ${formatCents(policy.require_approval_above)}. Manager approval required before ticketing.`
      );
    }
  }

  // ------------------------------------------------------------------
  // 6. POLICY EFFECTIVE DATES  (warning if policy has expired)
  // ------------------------------------------------------------------
  if (policy.effective_to && new Date(policy.effective_to) < new Date()) {
    warnings.push(
      `The travel policy expired on ${policy.effective_to} and has not been renewed. Please contact your account manager.`
    );
  }

  return {
    compliant  : violations.length === 0,
    violations,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = { checkPolicy, cabinExceedsPolicy, resolveAllowedCabin };
