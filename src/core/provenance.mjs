// Unified Data Provenance & Metric Envelope Schema (Batch A — T18)
// Distinguishes: observed | derived | estimated | insufficient_data | unverified_source | not_comparable | template_draft | user_supplied | unknown | demo | legacy_unverified

export const VALID_METRIC_STATUSES = new Set([
  "observed",
  "derived",
  "estimated",
  "insufficient_data",
  "unverified_source",
  "not_comparable",
  "template_draft",
  "user_supplied",
  "unknown",
  "demo",
  "legacy_unverified"
]);

const MISSING_PRESERVED_STATUSES = new Set([
  "demo",
  "insufficient_data",
  "unverified_source",
  "not_comparable",
  "legacy_unverified"
]);

/**
 * Creates a standardized metric envelope with explicit provenance, freshness (asOf), and limitations.
 */
export function createMetric({
  value = null,
  status = "unknown",
  source = null,
  sourceRef = null,
  collectedAt = null,
  asOf = null,
  sampleSize = null,
  minRequired = null,
  baselineId = null,
  format = null,
  methodVersion = null,
  caveats = null,
  reason = null,
  assumptions = null,
  isRounded = undefined
} = {}) {
  const isMissing =
    value === null ||
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value));

  const resolvedStatus = isMissing
    ? MISSING_PRESERVED_STATUSES.has(status)
      ? status
      : "unknown"
    : VALID_METRIC_STATUSES.has(status)
      ? status
      : "unknown";

  const resolvedReason = isMissing
    ? reason || "data_not_available_from_source"
    : reason || null;

  const timestamp = asOf || collectedAt || null;

  const metric = {
    value: isMissing ? null : value,
    status: resolvedStatus,
    source: source || null,
    asOf: timestamp,
    collectedAt: timestamp,
    reason: resolvedReason
  };

  if (sourceRef !== null && sourceRef !== undefined) metric.sourceRef = sourceRef;
  if (sampleSize !== null && sampleSize !== undefined) metric.sampleSize = sampleSize;
  if (minRequired !== null && minRequired !== undefined) metric.minRequired = minRequired;
  if (baselineId !== null && baselineId !== undefined) metric.baselineId = baselineId;
  if (format !== null && format !== undefined) metric.format = format;
  if (methodVersion !== null && methodVersion !== undefined) metric.methodVersion = methodVersion;
  if (caveats !== null && caveats !== undefined) metric.caveats = caveats;
  if (assumptions !== null && assumptions !== undefined) metric.assumptions = assumptions;
  if (isRounded !== undefined) metric.isRounded = Boolean(isRounded);

  return metric;
}

export function unwrapMetricValue(field, fallback = null) {
  if (field === null || field === undefined) return fallback;
  if (typeof field === "object" && "value" in field && "status" in field) {
    return field.value ?? fallback;
  }
  return field;
}

export function getMetricStatus(field) {
  if (field && typeof field === "object" && "status" in field) {
    return field.status;
  }
  return field === null || field === undefined ? "unknown" : "legacy_unverified";
}
