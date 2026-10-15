// Unified Data Provenance & Metric Envelope Schema (Batch 1)
// Distinguishes: observed | derived | estimated | unknown | demo | legacy_unverified

export const VALID_METRIC_STATUSES = new Set([
  "observed",
  "derived",
  "estimated",
  "unknown",
  "demo",
  "legacy_unverified"
]);

/**
 * Creates a standardized metric envelope with explicit provenance and limitations.
 */
export function createMetric({
  value = null,
  status = "unknown",
  source = null,
  sourceRef = null,
  collectedAt = null,
  sampleSize = null,
  methodVersion = null,
  reason = null,
  assumptions = null,
  isRounded = undefined
} = {}) {
  const isMissing =
    value === null ||
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value));

  const resolvedStatus = isMissing
    ? status === "demo"
      ? "demo"
      : "unknown"
    : VALID_METRIC_STATUSES.has(status)
      ? status
      : "unknown";

  const resolvedReason = isMissing
    ? reason || "data_not_available_from_source"
    : reason || null;

  const metric = {
    value: isMissing ? null : value,
    status: resolvedStatus,
    source: source || null,
    collectedAt: collectedAt || null,
    reason: resolvedReason
  };

  if (sourceRef !== null && sourceRef !== undefined) metric.sourceRef = sourceRef;
  if (sampleSize !== null && sampleSize !== undefined) metric.sampleSize = sampleSize;
  if (methodVersion !== null && methodVersion !== undefined) metric.methodVersion = methodVersion;
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
